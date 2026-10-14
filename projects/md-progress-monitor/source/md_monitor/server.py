"""WebSocket producer and static browser server for the local MD monitor."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import mimetypes
import re
import signal
import uuid
from collections import deque
from datetime import datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from websockets.exceptions import ConnectionClosed
from websockets.server import serve

from .schema import FRAME_SCHEMA, FRAME_UNITS, SCHEMA_VERSION, validate_frame
from .trajectory import PROJECT_ROOT, load_trajectory


PUBLIC_ROOT = PROJECT_ROOT / "public"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_INTERVAL = 0.65
DEFAULT_PLAYBACK_MODE = "realtime"
PLAYBACK_MODES = ("realtime", "accelerated")
BUFFER_LIMIT = 28
ACCELERATED_YIELD_EVERY = 64
WEBSOCKET_MAX_QUEUE = 16
WEBSOCKET_MAX_SIZE = 16_384
WEBSOCKET_WRITE_LIMIT = 65_536
MAX_SAFE_INTEGER = 9_007_199_254_740_991
_INTEGER_PATTERN = re.compile(r"(?:0|[1-9][0-9]*|-[1-9][0-9]*)\Z")


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _parse_timestamp(value: Any, context: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{context} timestamp must be canonical UTC ISO format")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        raise ValueError(f"{context} timestamp must be canonical UTC ISO format") from error
    canonical = parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"
    if canonical != value:
        raise ValueError(f"{context} timestamp must be canonical UTC ISO format")
    return parsed


def _finite_number(value: Any, field: str) -> float:
    if type(value) not in (int, float):
        raise ValueError(f"frame field {field!r} must be a finite number")
    try:
        numeric_value = float(value)
    except (OverflowError, TypeError) as error:
        raise ValueError(f"frame field {field!r} must be a finite number") from error
    if not math.isfinite(numeric_value):
        raise ValueError(f"frame field {field!r} must be a finite number")
    return numeric_value


def _first_positive_gap(frames: list[dict[str, Any]], field: str, fallback: Any) -> Any:
    previous = frames[0][field]
    for frame in frames[1:]:
        current = frame[field]
        gap = current - previous
        if gap > 0:
            return gap
        previous = current
    return fallback


def json_message(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def static_response(request_path: str) -> tuple[HTTPStatus, list[tuple[str, str]], bytes]:
    """Return a small static HTTP response for the websocket server's HTTP hook."""

    requested = unquote(urlsplit(request_path).path)
    relative = "index.html" if requested in {"", "/", "/index.html"} else requested.lstrip("/")
    candidate = (PUBLIC_ROOT / relative).resolve()

    if candidate != PUBLIC_ROOT and PUBLIC_ROOT not in candidate.parents:
        return HTTPStatus.NOT_FOUND, [("Content-Length", "0")], b""
    if not candidate.is_file():
        body = b"Not found"
        return (
            HTTPStatus.NOT_FOUND,
            [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body)))],
            body,
        )

    body = candidate.read_bytes()
    content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
        content_type += "; charset=utf-8"
    return (
        HTTPStatus.OK,
        [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-cache"),
        ],
        body,
    )


class CursorError(ValueError):
    """Raised when a websocket cursor query cannot be interpreted."""


def parse_cursor(path: str) -> tuple[str | None, int | None]:
    """Parse the optional reconnect cursor from a websocket request path.

    A cursor is either absent, or consists of one ``run_id`` and one ``after``
    parameter.  Keeping this validation separate from the websocket handler
    makes the close-with-error behavior deterministic and easy to exercise.
    """

    query_values: dict[str, list[str]] = {}
    for key, value in parse_qsl(urlsplit(path).query, keep_blank_values=True):
        if key in {"run_id", "after"}:
            query_values.setdefault(key, []).append(value)

    for key, values in query_values.items():
        if len(values) != 1:
            raise CursorError(f"duplicate {key} query parameter")

    has_run_id = "run_id" in query_values
    has_after = "after" in query_values
    if has_run_id != has_after:
        raise CursorError("run_id and after query parameters are required together")
    if not has_run_id:
        return None, None

    run_id = query_values["run_id"][0]
    if not run_id:
        raise CursorError("run_id query parameter must not be empty")

    raw_after = query_values["after"][0]
    if not _INTEGER_PATTERN.fullmatch(raw_after):
        raise CursorError("after query parameter must be a safe integer")
    after = int(raw_after)
    if after < -1 or after > MAX_SAFE_INTEGER:
        raise CursorError("after query parameter must be between -1 and 9007199254740991")
    return run_id, after


class MonitorProducer:
    """Replay frames and expose a bounded, reconnectable stream to clients."""

    def __init__(
        self,
        trajectory: dict[str, Any],
        interval: float,
        playback_mode: str = DEFAULT_PLAYBACK_MODE,
        repeat: int = 1,
    ) -> None:
        if playback_mode not in PLAYBACK_MODES:
            raise ValueError(
                f"playback_mode must be one of {', '.join(PLAYBACK_MODES)}, "
                f"received {playback_mode!r}"
            )
        if type(repeat) is not int or repeat <= 0:
            raise ValueError(f"repeat must be a positive integer, received {repeat!r}")
        self.trajectory = trajectory
        self.interval = max(0.1, interval)
        self.playback_mode = playback_mode
        self.repeat = repeat
        self.repeat_count = repeat
        self._base_frame_count = len(self.frames)
        if self._base_frame_count <= 0:
            raise ValueError("trajectory must contain at least one frame")
        self._total_frames = self._base_frame_count * repeat
        if self._total_frames > MAX_SAFE_INTEGER:
            raise ValueError("repeat produces more than the safe maximum frame count")
        (
            self._step_cycle_offset,
            self._time_cycle_offset,
            self._timestamp_cycle_offset,
        ) = self._replay_offsets()
        self._validate_replay_bounds()
        self.clients: set[Any] = set()
        self.buffer: deque[dict[str, Any]] = deque(maxlen=BUFFER_LIMIT)
        self.pause_event = asyncio.Event()
        self.pause_event.set()
        self.status = "starting"
        self.paused = False
        self.current_index = -1
        self.latest_sequence = -1
        self._last_step: int | None = None
        self._last_time_fs: float | None = None
        self._last_timestamp: str | None = None
        self.run_id = uuid.uuid4().hex
        self.task: asyncio.Task[None] | None = None
        self._state_lock = asyncio.Lock()

    @property
    def frames(self) -> list[dict[str, Any]]:
        return self.trajectory["frames"]

    @property
    def total_frames(self) -> int:
        return self._total_frames

    def _replay_offsets(self) -> tuple[int, float, timedelta]:
        """Derive one safe, positive offset for each repeated base recording."""

        first = self.frames[0]
        last = self.frames[-1]

        previous_step = None
        previous_time = None
        previous_timestamp = None
        for frame_index, frame in enumerate(self.frames):
            step = frame.get("step")
            if type(step) is not int or not 0 <= step <= MAX_SAFE_INTEGER:
                raise ValueError("frame field 'step' must be a non-negative safe integer")
            if previous_step is not None and step <= previous_step:
                raise ValueError("base frame step values must increase")
            time_fs = _finite_number(frame.get("time_fs"), "time_fs")
            if time_fs < 0 or (frame_index and time_fs <= previous_time):
                raise ValueError("base frame time_fs values must increase")
            timestamp = _parse_timestamp(frame.get("timestamp"), "frame")
            if frame_index and timestamp < previous_timestamp:
                raise ValueError("base frame timestamps must not move backwards")
            previous_step = step
            previous_time = time_fs
            previous_timestamp = timestamp

        step_gap = _first_positive_gap(
            self.frames, "step", 1
        )
        if type(step_gap) is not int or step_gap <= 0:
            raise ValueError("base frame step gaps must be positive safe integers")
        step_offset = last["step"] - first["step"] + step_gap
        if step_offset <= 0 or step_offset > MAX_SAFE_INTEGER:
            raise ValueError("replay step offset is not a positive safe integer")

        time_gap = _first_positive_gap(
            self.frames,
            "time_fs",
            _finite_number(self.trajectory.get("timestep_fs", 1), "timestep_fs"),
        )
        time_offset = (
            _finite_number(last["time_fs"], "time_fs")
            - _finite_number(first["time_fs"], "time_fs")
            + _finite_number(time_gap, "time_fs")
        )
        if time_offset <= 0 or not math.isfinite(time_offset):
            raise ValueError("replay time offset must be a positive finite number")

        timestamps = [_parse_timestamp(frame["timestamp"], "frame") for frame in self.frames]
        positive_timestamp_gap = timedelta(milliseconds=1)
        for previous, current in zip(timestamps, timestamps[1:]):
            gap = current - previous
            if gap > timedelta(0):
                positive_timestamp_gap = gap
                break
        timestamp_offset = timestamps[-1] - timestamps[0] + positive_timestamp_gap
        if timestamp_offset <= timedelta(0):
            raise ValueError("replay timestamp offset must be positive")
        return step_offset, time_offset, timestamp_offset

    def _validate_replay_bounds(self) -> None:
        """Reject overflow before a repeated producer can start publishing."""

        final_cycle = self.repeat - 1
        final_step = self.frames[-1]["step"] + final_cycle * self._step_cycle_offset
        if final_step > MAX_SAFE_INTEGER:
            raise ValueError("replay steps exceed the safe integer maximum")

        final_time = _finite_number(self.frames[-1]["time_fs"], "time_fs")
        try:
            final_time += final_cycle * self._time_cycle_offset
        except OverflowError as error:
            raise ValueError("replay time exceeds the finite numeric range") from error
        if not math.isfinite(final_time):
            raise ValueError("replay time exceeds the finite numeric range")
        if final_cycle and final_time <= self.frames[-1]["time_fs"]:
            raise ValueError("replay time cannot remain strictly increasing")

        try:
            final_timestamp = _parse_timestamp(
                self.frames[-1]["timestamp"], "frame"
            ) + final_cycle * self._timestamp_cycle_offset
        except (OverflowError, ValueError) as error:
            raise ValueError("replay timestamps exceed the supported calendar range") from error
        if final_timestamp.year > 9999:
            raise ValueError("replay timestamps exceed the supported calendar range")

    @staticmethod
    def _format_timestamp(value: datetime) -> str:
        return (
            f"{value.year:04d}-{value.month:02d}-{value.day:02d}T"
            f"{value.hour:02d}:{value.minute:02d}:{value.second:02d}."
            f"{value.microsecond // 1000:03d}Z"
        )

    def _replay_frame(self, frame_index: int) -> dict[str, Any]:
        cycle, base_index = divmod(frame_index, self._base_frame_count)
        source_frame = self.frames[base_index]
        frame = dict(source_frame)
        frame["sequence"] = frame_index
        frame["index"] = frame_index
        if cycle:
            frame["step"] = source_frame["step"] + cycle * self._step_cycle_offset
            frame["time_fs"] = (
                _finite_number(source_frame["time_fs"], "time_fs")
                + cycle * self._time_cycle_offset
            )
            timestamp = _parse_timestamp(source_frame["timestamp"], "frame")
            frame["timestamp"] = self._format_timestamp(
                timestamp + cycle * self._timestamp_cycle_offset
            )
        return frame

    @property
    def oldest_sequence(self) -> int:
        return self.buffer[0]["sequence"] if self.buffer else 0

    def _envelope(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            **payload,
            "schema_version": SCHEMA_VERSION,
            "run_id": self.run_id,
        }

    def metadata(self) -> dict[str, Any]:
        """Return metadata with the stable producer fields and stream contract."""

        reference_frame = validate_frame(
            self.frames[0],
            atom_count=len(self.trajectory["atoms"]),
            expected_sequence=0,
        )
        return self._envelope(
            {
                "type": "metadata",
                "frame_schema": FRAME_SCHEMA,
                "units": dict(FRAME_UNITS),
                "name": self.trajectory["name"],
                "source": self.trajectory["source"],
                "atom_count": len(self.trajectory["atoms"]),
                "atoms": self.trajectory["atoms"],
                "total_frames": self.total_frames,
                "repeat_count": self.repeat_count,
                "timestep_fs": self.trajectory["timestep_fs"],
                "buffer_limit": self.buffer.maxlen,
                "playback_mode": self.playback_mode,
                "interval_ms": (
                    0 if self.playback_mode == "accelerated" else round(self.interval * 1000)
                ),
                "reference_frame": reference_frame,
            }
        )

    def status_message(self) -> dict[str, Any]:
        return self._envelope(
            {
                "type": "status",
                "status": self.status,
                "paused": self.paused,
                "current_index": self.current_index,
                "latest_sequence": self.latest_sequence,
                "buffer_size": len(self.buffer),
            }
        )

    def snapshot_message(
        self,
        *,
        mode: str = "reset",
        reason: str | None = "initial",
        frames: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return self._envelope(
            {
                "type": "snapshot",
                "mode": mode,
                "reason": reason,
                "frames": list(self.buffer) if frames is None else frames,
                "current_index": self.current_index,
                "latest_sequence": self.latest_sequence,
                "oldest_sequence": self.oldest_sequence,
            }
        )

    def error_message(self, message: str) -> dict[str, Any]:
        return self._envelope({"type": "error", "message": message})

    def _message_for_cursor(
        self, requested_run_id: str | None, after: int | None
    ) -> dict[str, Any]:
        if requested_run_id is None:
            return self.snapshot_message(mode="reset", reason="initial")
        if requested_run_id != self.run_id:
            return self.snapshot_message(mode="reset", reason="run_changed")
        if after is None:
            raise ValueError("a cursor requires an after value")

        if after > self.latest_sequence:
            return self.snapshot_message(mode="reset", reason="cursor_ahead")
        if after < self.oldest_sequence - 1:
            return self.snapshot_message(mode="reset", reason="cursor_expired")

        suffix = [frame for frame in self.buffer if frame["sequence"] > after]
        return self.snapshot_message(mode="resume", reason=None, frames=suffix)

    async def _broadcast_locked(self, payload: dict[str, Any]) -> None:
        clients = tuple(self.clients)
        if not clients:
            return
        message = json_message(self._envelope(payload))
        results = await asyncio.gather(
            *(client.send(message) for client in clients), return_exceptions=True
        )
        for client, result in zip(clients, results):
            if isinstance(result, BaseException):
                self.clients.discard(client)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        """Broadcast one envelope to a stable snapshot of registered clients."""

        async with self._state_lock:
            await self._broadcast_locked(payload)

    async def connect(
        self,
        websocket: Any,
        *,
        requested_run_id: str | None = None,
        after: int | None = None,
    ) -> None:
        """Register a client and send its complete handshake atomically."""

        async with self._state_lock:
            self.clients.add(websocket)
            try:
                messages = (
                    self.metadata(),
                    self._message_for_cursor(requested_run_id, after),
                    self.status_message(),
                )
                for message in messages:
                    await websocket.send(json_message(message))
            except BaseException:
                self.clients.discard(websocket)
                raise

    async def disconnect(self, websocket: Any) -> None:
        async with self._state_lock:
            self.clients.discard(websocket)

    async def pause(self) -> None:
        async with self._state_lock:
            if self.status not in {"running", "starting"}:
                return
            self.paused = True
            self.status = "paused"
            self.pause_event.clear()
            await self._broadcast_locked(
                {
                    "type": "status",
                    "status": self.status,
                    "paused": self.paused,
                    "current_index": self.current_index,
                    "latest_sequence": self.latest_sequence,
                    "buffer_size": len(self.buffer),
                }
            )

    async def resume(self) -> None:
        async with self._state_lock:
            if self.status != "paused":
                return
            self.paused = False
            self.status = "running"
            self.pause_event.set()
            await self._broadcast_locked(
                {
                    "type": "status",
                    "status": self.status,
                    "paused": self.paused,
                    "current_index": self.current_index,
                    "latest_sequence": self.latest_sequence,
                    "buffer_size": len(self.buffer),
                }
            )

    async def restart(self) -> None:
        if self.task and not self.task.done() and self.task is not asyncio.current_task():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

        async with self._state_lock:
            self._reset_state_locked()
            await self._broadcast_locked(self.metadata())
            await self._broadcast_locked(
                {
                    "type": "snapshot",
                    "mode": "reset",
                    "reason": "run_changed",
                    "frames": [],
                    "current_index": -1,
                    "latest_sequence": -1,
                    "oldest_sequence": 0,
                }
            )
            await self._broadcast_locked(
                {
                    "type": "status",
                    "status": self.status,
                    "paused": self.paused,
                    "current_index": self.current_index,
                    "latest_sequence": self.latest_sequence,
                    "buffer_size": len(self.buffer),
                }
            )
            self.task = asyncio.create_task(self.produce())

    def _reset_state_locked(self) -> None:
        """Reset all replay state while the producer state lock is held."""

        self.run_id = uuid.uuid4().hex
        self.buffer.clear()
        self.current_index = -1
        self.latest_sequence = -1
        self._last_step = None
        self._last_time_fs = None
        self._last_timestamp = None
        self.paused = False
        self.status = "running"
        self.pause_event.set()

    async def publish_frame(self, frame: dict[str, Any]) -> dict[str, Any]:
        """Validate, retain, and publish one normalized frame without sleeping."""

        async with self._state_lock:
            return await self._publish_frame_locked(frame)

    async def _publish_frame_locked(self, frame: dict[str, Any]) -> dict[str, Any]:
        normalized = validate_frame(
            frame,
            atom_count=len(self.trajectory["atoms"]),
            expected_sequence=self.latest_sequence + 1,
            previous_step=self._last_step,
            previous_time_fs=self._last_time_fs,
            previous_timestamp=self._last_timestamp,
        )
        self.buffer.append(normalized)
        self.current_index = normalized["index"]
        self.latest_sequence = normalized["sequence"]
        self._last_step = normalized["step"]
        self._last_timestamp = normalized["timestamp"]
        self._last_time_fs = normalized["time_fs"]
        await self._broadcast_locked(
            {
                "type": "frame",
                "frame": normalized,
                "buffer_size": len(self.buffer),
            }
        )
        return normalized

    async def _wait_and_publish(self, frame: dict[str, Any]) -> bool:
        """Wait for playback and recheck pause state while holding the state lock."""

        while True:
            await self.pause_event.wait()
            async with self._state_lock:
                if self.paused or self.status == "paused":
                    continue
                await self._publish_frame_locked(frame)
                return True

    async def produce(self) -> None:
        async with self._state_lock:
            if self.status != "paused":
                self.status = "running"
                self.paused = False
                await self._broadcast_locked(
                    {
                        "type": "status",
                        "status": self.status,
                        "paused": self.paused,
                        "current_index": self.current_index,
                        "latest_sequence": self.latest_sequence,
                        "buffer_size": len(self.buffer),
                    }
                )

        for frame_index in range(self.total_frames):
            await self._wait_and_publish(self._replay_frame(frame_index))
            if frame_index < self.total_frames - 1:
                if self.playback_mode == "realtime":
                    await asyncio.sleep(self.interval)
                elif (frame_index + 1) % ACCELERATED_YIELD_EVERY == 0:
                    await asyncio.sleep(0)

        async with self._state_lock:
            self.paused = False
            self.status = "complete"
            await self._broadcast_locked(
                {
                    "type": "status",
                    "status": self.status,
                    "paused": self.paused,
                    "current_index": self.current_index,
                    "latest_sequence": self.latest_sequence,
                    "buffer_size": len(self.buffer),
                }
            )

    async def shutdown(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass


async def _reject_cursor(websocket: Any, producer: MonitorProducer, message: str) -> None:
    await websocket.send(json_message(producer.error_message(message)))
    await websocket.close(code=1008, reason=message[:123])


async def websocket_handler(websocket: Any, path: str, producer: MonitorProducer) -> None:
    if urlsplit(path).path != "/ws":
        await websocket.send(json_message(producer.error_message("WebSocket endpoint is /ws")))
        await websocket.close(code=1008, reason="WebSocket endpoint is /ws")
        return

    try:
        requested_run_id, after = parse_cursor(path)
    except CursorError as error:
        await _reject_cursor(websocket, producer, str(error))
        return

    try:
        await producer.connect(websocket, requested_run_id=requested_run_id, after=after)
    except ConnectionClosed:
        await producer.disconnect(websocket)
        return

    try:
        async for raw_message in websocket:
            try:
                command = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send(json_message(producer.error_message("Invalid JSON command")))
                continue
            action = command.get("action") if isinstance(command, dict) else None
            if action == "pause":
                await producer.pause()
            elif action == "resume":
                await producer.resume()
            elif action == "restart":
                await producer.restart()
            elif action == "ping":
                await websocket.send(
                    json_message(producer._envelope({"type": "pong"}))
                )
            else:
                await websocket.send(
                    json_message(
                        producer.error_message(f"Unknown action: {action!r}")
                    )
                )
    except ConnectionClosed:
        pass
    finally:
        await producer.disconnect(websocket)


async def run_server(
    host: str,
    port: int,
    interval: float,
    playback_mode: str = DEFAULT_PLAYBACK_MODE,
    repeat: int = 1,
) -> None:
    trajectory = load_trajectory()
    producer = MonitorProducer(trajectory, interval, playback_mode, repeat)

    async def process_request(
        path: str, _request_headers: Any
    ) -> tuple[HTTPStatus, list[tuple[str, str]], bytes] | None:
        if urlsplit(path).path == "/ws":
            return None
        return static_response(path)

    async def handler(websocket: Any, path: str) -> None:
        await websocket_handler(websocket, path, producer)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signal_name in ("SIGINT", "SIGTERM"):
        try:
            loop.add_signal_handler(getattr(signal, signal_name), stop_event.set)
        except (AttributeError, NotImplementedError):
            pass

    async with serve(
        handler,
        host,
        port,
        process_request=process_request,
        ping_interval=20,
        ping_timeout=20,
        max_queue=WEBSOCKET_MAX_QUEUE,
        max_size=WEBSOCKET_MAX_SIZE,
        write_limit=WEBSOCKET_WRITE_LIMIT,
    ):
        producer.task = asyncio.create_task(producer.produce())
        print(f"MD monitor running at http://{host}:{port}")
        print(f"Streaming {producer.total_frames} frames from {trajectory['name']}")
        await stop_event.wait()
        await producer.shutdown()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the local MD progress monitor")
    parser.add_argument("--host", default=DEFAULT_HOST, help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP/WebSocket port")
    parser.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_INTERVAL,
        help="seconds between streamed frames in realtime mode (default: 0.65)",
    )
    parser.add_argument(
        "--playback-mode",
        choices=PLAYBACK_MODES,
        default=DEFAULT_PLAYBACK_MODE,
        help="realtime playback or no-delay accelerated playback (default: realtime)",
    )
    parser.add_argument(
        "--repeat",
        type=_positive_int,
        default=1,
        help="number of lazy playback cycles (default: 1)",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        asyncio.run(
            run_server(args.host, args.port, args.interval, args.playback_mode, args.repeat)
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
