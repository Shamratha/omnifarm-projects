import asyncio
import json
from collections import deque
from contextlib import asynccontextmanager
from typing import Any

import pytest
import websockets
from websockets.server import serve

from md_monitor.schema import StreamValidationError
from md_monitor.server import MonitorProducer, websocket_handler
from md_monitor.trajectory import load_trajectory


def run(coro):
    return asyncio.run(coro)


@asynccontextmanager
async def running_server(producer: MonitorProducer):
    async def handler(websocket: Any, path: str) -> None:
        await websocket_handler(websocket, path, producer)

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        yield f"ws://127.0.0.1:{port}/ws"


async def receive_handshake(websocket):
    return [json.loads(await websocket.recv()) for _ in range(3)]


def test_initial_snapshot_contains_contract_and_latest_status():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        await producer.publish_frame(producer.frames[0])

        async with running_server(producer) as url:
            async with websockets.connect(url) as websocket:
                metadata, snapshot, status = await receive_handshake(websocket)

                assert [message["type"] for message in (metadata, snapshot, status)] == [
                    "metadata",
                    "snapshot",
                    "status",
                ]
                for message in (metadata, snapshot, status):
                    assert message["schema_version"] == 1
                    assert message["run_id"] == producer.run_id
                assert metadata["frame_schema"] == "md-progress-frame/v1"
                assert metadata["units"] == {
                    "position": "angstrom",
                    "time": "femtosecond",
                    "temperature": "kelvin",
                    "potential_energy": "kilojoule_per_mole",
                }
                assert snapshot["mode"] == "reset"
                assert snapshot["reason"] == "initial"
                assert snapshot["latest_sequence"] == 0
                assert snapshot["oldest_sequence"] == 0
                assert status["current_index"] == 0
                assert status["latest_sequence"] == 0
                frame = snapshot["frames"][0]
                assert frame["schema_version"] == 1
                assert frame["sequence"] == frame["index"] == 0
                assert frame["units"] == metadata["units"]
                assert metadata["reference_frame"] == frame

    run(scenario())


def test_resume_returns_only_missing_suffix_and_up_to_date_is_empty():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        for frame in producer.frames[:5]:
            await producer.publish_frame(frame)

        async with running_server(producer) as url:
            async with websockets.connect(
                f"{url}?run_id={producer.run_id}&after=1"
            ) as websocket:
                _metadata, snapshot, _status = await receive_handshake(websocket)
                assert snapshot["mode"] == "resume"
                assert snapshot["reason"] is None
                assert [frame["sequence"] for frame in snapshot["frames"]] == [2, 3, 4]

            async with websockets.connect(
                f"{url}?run_id={producer.run_id}&after=4"
            ) as websocket:
                _metadata, snapshot, _status = await receive_handshake(websocket)
                assert snapshot["mode"] == "resume"
                assert snapshot["frames"] == []
                assert snapshot["latest_sequence"] == 4

            async with websockets.connect(
                f"{url}?run_id={producer.run_id}&after=5"
            ) as websocket:
                _metadata, snapshot, _status = await receive_handshake(websocket)
                assert snapshot["mode"] == "reset"
                assert snapshot["reason"] == "cursor_ahead"
                assert [frame["sequence"] for frame in snapshot["frames"]] == [0, 1, 2, 3, 4]

    run(scenario())


def test_expired_cursor_resets_to_the_bounded_buffer():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        producer.buffer = deque(maxlen=3)
        for frame in producer.frames[:5]:
            await producer.publish_frame(frame)

        async with running_server(producer) as url:
            async with websockets.connect(
                f"{url}?run_id={producer.run_id}&after=0"
            ) as websocket:
                metadata, snapshot, _status = await receive_handshake(websocket)
                assert metadata["buffer_limit"] == 3
                assert snapshot["mode"] == "reset"
                assert snapshot["reason"] == "cursor_expired"
                assert [frame["sequence"] for frame in snapshot["frames"]] == [2, 3, 4]
                assert snapshot["oldest_sequence"] == 2

    run(scenario())


def test_metadata_keeps_frame_zero_available_after_buffer_eviction():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        producer.buffer = deque(maxlen=3)
        for frame in producer.frames[:5]:
            await producer.publish_frame(frame)

        metadata = producer.metadata()

        assert [frame["sequence"] for frame in producer.buffer] == [2, 3, 4]
        assert metadata["reference_frame"]["sequence"] == metadata["reference_frame"]["index"] == 0
        assert metadata["reference_frame"] == producer.frames[0]
        assert metadata["reference_frame"]["schema_version"] == 1
        assert metadata["reference_frame"]["units"] == metadata["units"]
        metadata["reference_frame"]["positions"][0][0] = 999
        metadata["reference_frame"]["units"]["position"] = "nanometer"
        assert producer.frames[0]["positions"][0][0] != 999
        assert producer.frames[0]["units"]["position"] == "angstrom"

        async with running_server(producer) as url:
            for connection_url, reason in (
                (url, "initial"),
                (f"{url}?run_id={producer.run_id}&after=0", "cursor_expired"),
            ):
                async with websockets.connect(connection_url) as websocket:
                    metadata, snapshot, _status = await receive_handshake(websocket)
                    assert metadata["reference_frame"] == producer.frames[0]
                    assert metadata["buffer_limit"] == 3
                    assert snapshot["mode"] == "reset"
                    assert snapshot["reason"] == reason
                    assert [frame["sequence"] for frame in snapshot["frames"]] == [2, 3, 4]
                    assert [frame["sequence"] for frame in producer.buffer] == [2, 3, 4]

    run(scenario())


@pytest.mark.parametrize(
    "overrides",
    [
        {"schema_version": 2},
        {"positions": []},
        {"positions": [[float("nan"), 0, 0]]},
        {"sequence": 1, "index": 1},
        {"index": 1},
        {"units": {"position": "angstrom"}},
    ],
)
def test_metadata_validates_reference_without_changing_the_buffer(overrides):
    producer = MonitorProducer(load_trajectory(), interval=0)
    producer.frames[0].update(overrides)

    with pytest.raises(StreamValidationError):
        producer.metadata()

    assert not producer.buffer
    assert producer.latest_sequence == producer.current_index == -1


def test_restart_changes_run_and_old_cursor_is_reset():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        await producer.publish_frame(producer.frames[0])
        old_run_id = producer.run_id

        async with running_server(producer) as url:
            async with websockets.connect(url) as websocket:
                await receive_handshake(websocket)
                await websocket.send(json.dumps({"action": "restart"}))
                metadata, snapshot, status = await receive_handshake(websocket)
                assert metadata["type"] == "metadata"
                assert snapshot["type"] == "snapshot"
                assert status["type"] == "status"
                assert metadata["run_id"] != old_run_id
                assert metadata["reference_frame"] == producer.frames[0]
                assert snapshot["run_id"] == metadata["run_id"]
                assert snapshot["mode"] == "reset"
                assert snapshot["reason"] == "run_changed"
                assert snapshot["frames"] == []

                await producer.shutdown()

            async with websockets.connect(
                f"{url}?run_id={old_run_id}&after=0"
            ) as websocket:
                _metadata, snapshot, _status = await receive_handshake(websocket)
                assert snapshot["mode"] == "reset"
                assert snapshot["reason"] == "run_changed"

    run(scenario())


def test_malformed_cursor_is_reported_and_closed_with_policy_violation():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        malformed_urls = [
            "/ws?run_id=only",
            f"/ws?run_id={producer.run_id}&after=1&after=2",
            f"/ws?run_id={producer.run_id}&after=9007199254740992",
            f"/ws?run_id={producer.run_id}&after=not-an-integer",
        ]

        async with running_server(producer) as base_url:
            for path in malformed_urls:
                async with websockets.connect(base_url.rsplit("/ws", 1)[0] + path) as websocket:
                    error = json.loads(await websocket.recv())
                    assert error["type"] == "error"
                    assert error["schema_version"] == 1
                    await websocket.wait_closed()
                    assert websocket.close_code == 1008

    run(scenario())


def test_handshake_and_publish_are_serialized_without_missing_live_frame():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        frame = producer.frames[0]

        async with running_server(producer) as url:
            async with websockets.connect(url) as websocket:
                publish_task = asyncio.create_task(producer.publish_frame(frame))
                messages = await receive_handshake(websocket)
                await publish_task

                assert [message["type"] for message in messages] == [
                    "metadata",
                    "snapshot",
                    "status",
                ]
                snapshot = messages[1]
                if snapshot["frames"]:
                    assert [item["sequence"] for item in snapshot["frames"]] == [0]
                else:
                    live = json.loads(await websocket.recv())
                    assert live["type"] == "frame"
                    assert live["frame"]["sequence"] == 0

    run(scenario())


def test_pause_and_resume_commands_control_the_replay_task():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        async with running_server(producer) as url:
            async with websockets.connect(url) as websocket:
                await receive_handshake(websocket)

                await websocket.send(json.dumps({"action": "pause"}))
                paused = json.loads(await websocket.recv())
                assert paused["type"] == "status"
                assert paused["status"] == "paused"
                assert paused["paused"] is True

                producer.task = asyncio.create_task(producer.produce())
                await websocket.send(json.dumps({"action": "resume"}))
                resumed = json.loads(await websocket.recv())
                assert resumed["type"] == "status"
                assert resumed["status"] == "running"
                assert resumed["paused"] is False

                frame = json.loads(await websocket.recv())
                assert frame["type"] == "frame"
                assert frame["frame"]["sequence"] == 0
                await producer.shutdown()

    run(scenario())
