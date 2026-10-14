from pathlib import Path

from md_monitor.server import BUFFER_LIMIT, MonitorProducer, static_response
from md_monitor.trajectory import TRAJECTORY_PATH, load_trajectory


def test_bundled_trajectory_has_stream_fields_and_consistent_coordinates():
    trajectory = load_trajectory()

    assert TRAJECTORY_PATH.is_file()
    assert trajectory["name"] == "Ethanol thermalized demo"
    assert trajectory["timestep_fs"] == 2
    assert len(trajectory["atoms"]) == 10
    assert len(trajectory["frames"]) == 12

    for index, frame in enumerate(trajectory["frames"]):
        assert frame["index"] == index
        assert frame["timestamp"].endswith("Z")
        assert isinstance(frame["step"], int)
        assert len(frame["positions"]) == len(trajectory["atoms"])
        assert all(len(coordinate) == 3 for coordinate in frame["positions"])


def test_producer_buffer_is_bounded():
    producer = MonitorProducer(load_trajectory(), interval=0.1)

    for frame in producer.frames:
        producer.buffer.append(frame)

    assert len(producer.buffer) == min(BUFFER_LIMIT, len(producer.frames))
    assert producer.buffer[-1]["index"] == len(producer.frames) - 1


def test_static_server_serves_the_browser_entrypoint():
    status, headers, body = static_response("/")

    assert status.value == 200
    assert dict(headers)["Content-Type"].startswith("text/html")
    assert b"MD Progress Monitor" in body


def test_static_server_rejects_path_traversal():
    status, _headers, _body = static_response("/../README.md")

    assert status.value == 404
