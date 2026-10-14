import asyncio
import gc
import json
import tracemalloc
from collections import deque
from datetime import datetime, timedelta

import pytest

import md_monitor.server as server
from md_monitor.schema import FRAME_UNITS, SCHEMA_VERSION
from md_monitor.server import BUFFER_LIMIT, MonitorProducer, build_parser
from md_monitor.trajectory import load_trajectory


def run(coro):
    return asyncio.run(coro)


def synthetic_frame(sequence: int, *, atom_count: int = 16) -> dict:
    timestamp = datetime(2026, 5, 18, 10, 0, 0) + timedelta(milliseconds=sequence)
    return {
        "schema_version": SCHEMA_VERSION,
        "sequence": sequence,
        "index": sequence,
        "step": sequence,
        "timestamp": timestamp.strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z",
        "time_fs": sequence,
        "temperature_K": 298.4,
        "potential_energy_kj_mol": -215.84,
        "units": dict(FRAME_UNITS),
        "positions": [[float(sequence), float(atom), 0.0] for atom in range(atom_count)],
    }


def synthetic_trajectory(frame_count: int = 3) -> dict:
    return {
        "name": "synthetic playback",
        "source": "test",
        "timestep_fs": 1.0,
        "atoms": [{"element": "H", "label": f"H{atom + 1}"} for atom in range(16)],
        "frames": [synthetic_frame(sequence) for sequence in range(frame_count)],
    }


def test_accelerated_metadata_and_cli_defaults_are_explicit():
    producer = MonitorProducer(
        load_trajectory(), interval=0.65, playback_mode="accelerated"
    )

    metadata = producer.metadata()
    assert metadata["playback_mode"] == "accelerated"
    assert metadata["interval_ms"] == 0
    realtime_metadata = MonitorProducer(load_trajectory(), interval=0.65).metadata()
    assert realtime_metadata["playback_mode"] == "realtime"
    assert realtime_metadata["interval_ms"] == 650

    parser = build_parser()
    defaults = parser.parse_args([])
    assert defaults.playback_mode == "realtime"
    assert defaults.interval == server.DEFAULT_INTERVAL
    assert defaults.repeat == 1
    accelerated = parser.parse_args(["--playback-mode", "accelerated", "--interval", "10"])
    assert accelerated.playback_mode == "accelerated"
    assert accelerated.interval == 10
    repeated = parser.parse_args(["--playback-mode", "accelerated", "--repeat", "7"])
    assert repeated.repeat == 7
    assert "--playback-mode {realtime,accelerated}" in parser.format_help()
    with pytest.raises(SystemExit):
        parser.parse_args(["--playback-mode", "invalid"])
    for invalid_repeat in ("0", "-1", "not-an-int"):
        with pytest.raises(SystemExit):
            parser.parse_args(["--repeat", invalid_repeat])


def test_accelerated_produce_has_no_wall_clock_delay(monkeypatch):
    delays = []

    async def record_delay(delay):
        delays.append(delay)

    monkeypatch.setattr(server.asyncio, "sleep", record_delay)
    producer = MonitorProducer(
        synthetic_trajectory(frame_count=100), interval=10, playback_mode="accelerated"
    )

    run(producer.produce())

    assert producer.status == "complete"
    assert producer.latest_sequence == 99
    assert len(producer.buffer) == BUFFER_LIMIT
    assert all(delay == 0 for delay in delays)


def test_realtime_produce_preserves_interval_pacing(monkeypatch):
    delays = []

    async def record_delay(delay):
        delays.append(delay)

    monkeypatch.setattr(server.asyncio, "sleep", record_delay)
    producer = MonitorProducer(synthetic_trajectory(), interval=0.35)
    run(producer.produce())

    assert delays == [0.35, 0.35]
    assert producer.status == "complete"
    assert producer.latest_sequence == 2


def test_accelerated_produce_waits_for_client_backpressure():
    async def scenario():
        producer = MonitorProducer(
            synthetic_trajectory(), interval=10, playback_mode="accelerated"
        )
        blocked = asyncio.Event()
        release = asyncio.Event()

        class Client:
            frame_count = 0

            async def send(self, raw_message):
                message = json.loads(raw_message)
                if message["type"] == "frame":
                    assert message["frame"]["sequence"] == self.frame_count
                    if self.frame_count == 0:
                        blocked.set()
                        await release.wait()
                    self.frame_count += 1

        client = Client()
        await producer.connect(client)
        producer.task = asyncio.create_task(producer.produce())
        try:
            await blocked.wait()
            assert producer.latest_sequence == 0
            assert len(producer.buffer) == 1
            assert not producer.task.done()
            release.set()
            await producer.task
            assert client.frame_count == 3
            assert producer.status == "complete"
            assert producer.latest_sequence == 2
        finally:
            await producer.shutdown()

    run(scenario())


def test_many_accelerated_frames_keep_only_bounded_memory_and_latest_state():
    frame_count = 1000

    async def scenario():
        trajectory = synthetic_trajectory(frame_count=frame_count)
        producer = MonitorProducer(trajectory, interval=0, playback_mode="accelerated")
        buffer = producer.buffer

        async def publish(sequence):
            await producer.publish_frame(producer.frames[sequence])
            assert producer.buffer is buffer
            assert len(buffer) == min(sequence + 1, BUFFER_LIMIT)
            assert producer.latest_sequence == producer.current_index == sequence
            assert len(producer.frames) == frame_count
            # Reject an additional unbounded publication list/deque on the
            # producer; the fixed input trajectory is intentionally excluded.
            for name, value in vars(producer).items():
                if name == "trajectory":
                    continue
                if isinstance(value, (list, deque)):
                    assert len(value) <= BUFFER_LIMIT

        gc.collect()
        tracemalloc.start()
        try:
            baseline, _ = tracemalloc.get_traced_memory()
            for sequence in range(frame_count):
                await publish(sequence)
            gc.collect()
            current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        # Allow allocator/validation overhead, but not another 1,000-frame
        # history. The preloaded input is excluded from this measurement.
        assert current - baseline < 256 * 1024
        assert peak - baseline < 256 * 1024
        return producer

    producer = run(scenario())

    assert isinstance(producer.buffer, deque)
    assert producer.buffer.maxlen == BUFFER_LIMIT
    assert len(producer.buffer) <= BUFFER_LIMIT
    assert [frame["sequence"] for frame in producer.buffer] == list(
        range(frame_count - BUFFER_LIMIT, frame_count)
    )
    assert producer.latest_sequence == frame_count - 1
    assert producer.current_index == frame_count - 1
    assert producer.oldest_sequence == frame_count - BUFFER_LIMIT
    assert producer.snapshot_message()["frames"] == list(producer.buffer)
    assert len(producer.frames) == frame_count


def test_repeated_bundled_playback_is_lazy_and_preserves_replay_values():
    repeat = 1000
    trajectory = load_trajectory()

    async def scenario():
        producer = MonitorProducer(
            trajectory, interval=10, playback_mode="accelerated", repeat=repeat
        )
        observed: dict[int, dict] = {}
        previous_step = None
        previous_time = None
        previous_timestamp = None

        class Client:
            async def send(self, raw_message):
                nonlocal previous_step, previous_time, previous_timestamp
                message = json.loads(raw_message)
                if message["type"] != "frame":
                    return
                frame = message["frame"]
                assert frame["sequence"] == frame["index"]
                if previous_step is not None:
                    assert frame["step"] > previous_step
                    assert frame["time_fs"] > previous_time
                    assert frame["timestamp"] > previous_timestamp
                previous_step = frame["step"]
                previous_time = frame["time_fs"]
                previous_timestamp = frame["timestamp"]
                if frame["sequence"] in {0, 11, 12, 13, 999 * 12, 999 * 12 + 11}:
                    observed[frame["sequence"]] = frame

        await producer.connect(Client())
        producer.task = asyncio.create_task(producer.produce())
        await producer.task
        return producer, observed

    producer, observed = run(scenario())

    assert len(trajectory["frames"]) == 12
    assert producer.frames is trajectory["frames"]
    assert producer.total_frames == 12 * repeat
    assert producer.metadata()["total_frames"] == 12 * repeat
    assert producer.metadata()["repeat_count"] == repeat
    assert producer.metadata()["reference_frame"] == trajectory["frames"][0]
    assert producer.latest_sequence == 12 * repeat - 1
    assert len(producer.buffer) == BUFFER_LIMIT
    assert set(observed) == {0, 11, 12, 13, 999 * 12, 999 * 12 + 11}

    for sequence, frame in observed.items():
        base = trajectory["frames"][sequence % 12]
        assert frame["positions"] == base["positions"]
        assert frame["temperature_K"] == base["temperature_K"]
        assert frame["potential_energy_kj_mol"] == base["potential_energy_kj_mol"]
    assert observed[12]["step"] == trajectory["frames"][-1]["step"] + 20
    assert observed[12]["time_fs"] == trajectory["frames"][-1]["time_fs"] + 40
    assert observed[12]["timestamp"] == "2026-05-18T10:00:00.480Z"


def test_repeated_playback_restart_retains_repeat_configuration():
    async def scenario():
        producer = MonitorProducer(
            synthetic_trajectory(frame_count=3), interval=0, playback_mode="accelerated", repeat=4
        )
        first_task = asyncio.create_task(producer.produce())
        await first_task
        assert producer.latest_sequence == 11
        await producer.restart()
        assert producer.repeat == 4
        assert producer.repeat_count == 4
        assert producer.metadata()["total_frames"] == 12
        await producer.task
        return producer

    producer = run(scenario())
    assert producer.status == "complete"
    assert producer.latest_sequence == 11
    assert len(producer.frames) == 3


def test_accelerated_mode_yields_to_other_tasks_without_clients():
    async def scenario():
        producer = MonitorProducer(
            synthetic_trajectory(frame_count=3), interval=0, playback_mode="accelerated", repeat=100
        )
        observer_ran = asyncio.Event()
        observer_sequence = None

        async def observer():
            nonlocal observer_sequence
            observer_sequence = producer.latest_sequence
            observer_ran.set()

        producer.task = asyncio.create_task(producer.produce())
        observer_task = asyncio.create_task(observer())
        await observer_task
        assert observer_ran.is_set()
        assert observer_sequence < producer.total_frames - 1
        await producer.task

    run(scenario())


def test_pause_resume_uses_event_barriers_and_does_not_publish_after_pause_status():
    async def scenario():
        producer = MonitorProducer(
            synthetic_trajectory(frame_count=3), interval=0, playback_mode="accelerated", repeat=100
        )
        frame_started = asyncio.Event()
        release_frame = asyncio.Event()
        frame_count = 0

        class Client:
            async def send(self, raw_message):
                nonlocal frame_count
                message = json.loads(raw_message)
                if message["type"] == "frame":
                    frame_count += 1
                    if frame_count == 1:
                        frame_started.set()
                        await release_frame.wait()

        await producer.connect(Client())
        producer.task = asyncio.create_task(producer.produce())
        await frame_started.wait()

        pause_task = asyncio.create_task(producer.pause())
        release_frame.set()
        await pause_task
        assert producer.status == "paused"
        assert producer.latest_sequence == 0

        await producer.resume()
        await producer.task
        assert producer.status == "complete"
        assert producer.latest_sequence == 299

    run(scenario())


@pytest.mark.parametrize(
    "repeat",
    [0, -1, True, 1.0, "2"],
)
def test_producer_repeat_must_be_a_positive_integer(repeat):
    with pytest.raises(ValueError):
        MonitorProducer(synthetic_trajectory(), interval=0, repeat=repeat)


def test_repeated_playback_rejects_safe_integer_and_numeric_overflow_before_running():
    with pytest.raises(ValueError, match="safe maximum"):
        MonitorProducer(
            synthetic_trajectory(frame_count=3),
            interval=0,
            repeat=server.MAX_SAFE_INTEGER // 3 + 1,
        )

    overflowing_step = synthetic_trajectory(frame_count=1)
    overflowing_step["frames"][0]["step"] = server.MAX_SAFE_INTEGER
    with pytest.raises(ValueError, match="safe integer"):
        MonitorProducer(overflowing_step, interval=0, repeat=2)

    overflowing_time = synthetic_trajectory(frame_count=1)
    overflowing_time["frames"][0]["time_fs"] = 1e308
    with pytest.raises(ValueError, match="strictly increasing"):
        MonitorProducer(overflowing_time, interval=0, repeat=2)

    overflowing_timestamp = synthetic_trajectory(frame_count=1)
    overflowing_timestamp["frames"][0]["timestamp"] = "9999-12-31T23:59:59.999Z"
    with pytest.raises(ValueError, match="calendar range"):
        MonitorProducer(overflowing_timestamp, interval=0, repeat=2)


def test_restart_clears_buffer_and_sequence_before_accelerated_replay():
    async def scenario():
        producer = MonitorProducer(
            synthetic_trajectory(), interval=0.65, playback_mode="accelerated"
        )
        buffer = producer.buffer
        for frame in producer.frames:
            await producer.publish_frame(frame)
        old_run_id = producer.run_id
        await producer.pause()
        old_task = producer.task = asyncio.create_task(producer.produce())
        await asyncio.sleep(0)
        assert not old_task.done()

        await producer.restart()
        assert old_task.cancelled()
        assert producer.task is not old_task
        assert producer.run_id != old_run_id
        assert producer.buffer is buffer
        assert list(producer.buffer) == []
        assert producer.latest_sequence == -1
        assert producer.current_index == -1
        assert producer._last_step is None
        assert producer._last_time_fs is None
        assert producer._last_timestamp is None
        assert producer.paused is False
        assert producer.pause_event.is_set()
        assert producer.status == "running"

        await producer.task
        return producer

    producer = run(scenario())
    assert producer.status == "complete"
    assert producer.latest_sequence == 2
    assert len(producer.buffer) == 3
