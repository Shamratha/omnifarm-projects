"""End-to-end transport checks for a producer disconnect and reconnect."""

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

import websockets
from websockets.server import serve

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
        yield f"ws://127.0.0.1:{port}/ws", server


async def handshake(websocket):
    return [json.loads(await websocket.recv()) for _ in range(3)]


def test_producer_transport_disconnect_then_cursor_reconnect_resumes_missing_frames():
    async def scenario():
        producer = MonitorProducer(load_trajectory(), interval=0)
        for frame in producer.frames[:3]:
            await producer.publish_frame(frame)

        async with running_server(producer) as (url, server):
            async with websockets.connect(url) as websocket:
                metadata, snapshot, status = await handshake(websocket)
                assert metadata["run_id"] == producer.run_id
                assert [frame["sequence"] for frame in snapshot["frames"]] == [0, 1, 2]
                cursor_run = status["run_id"]
                cursor_after = status["latest_sequence"]

                # Close the transport while preserving the producer/run state.
                server.close()
                await server.wait_closed()
                await websocket.wait_closed()

        # The producer continues while no client is attached.
        await producer.publish_frame(producer.frames[3])
        await producer.publish_frame(producer.frames[4])

        async with running_server(producer) as (url, _server):
            async with websockets.connect(
                f"{url}?run_id={cursor_run}&after={cursor_after}"
            ) as websocket:
                metadata, snapshot, status = await handshake(websocket)
                assert metadata["run_id"] == cursor_run
                assert snapshot["mode"] == "resume"
                assert snapshot["reason"] is None
                assert [frame["sequence"] for frame in snapshot["frames"]] == [3, 4]
                assert status["latest_sequence"] == 4

        await producer.shutdown()

    run(scenario())
