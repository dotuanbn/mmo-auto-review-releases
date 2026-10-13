"""Loopback HTTP adapter for the bundled Laya multilingual checkpoint.

The adapter exposes only the small OpenAI-compatible surface used by MMO Auto
Review. It keeps Laya's choice/confidence semantics explicit; numeric risk and
health values are conservative bucket projections, not calibrated probabilities.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Protocol, cast

HOST = "127.0.0.1"
PORT = int(os.environ.get("LAYA_PORT", "8765"))
MAX_BODY_BYTES = 64 * 1024
MODEL_NAME = "tier1-local"
SERVICE_NAME = "mmo-laya-sidecar"
PROTOCOL_VERSION = 1
MODEL_DIR = Path(os.environ.get("LAYA_MODEL_DIR", Path(__file__).resolve().parent / "model" / "multilingual"))

class LayaAgent(Protocol):
    def predict(self, state: dict[str, object], questions: dict[str, object]) -> dict[str, object]: ...


_agent: LayaAgent | None = None
_agent_lock = threading.Lock()
_inference_lock = threading.Lock()


def _load_agent() -> LayaAgent:
    global _agent
    if _agent is not None:
        return _agent
    with _agent_lock:
        if _agent is None:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
            from laya import Agent

            _agent = cast(LayaAgent, Agent(str(MODEL_DIR), device="cpu", compile=False))
    return _agent


def _choose(state: dict[str, object], options: dict[str, str], instructions: str) -> tuple[str, float]:
    agent = _load_agent()
    if not _inference_lock.acquire(timeout=1.0):
        raise RuntimeError("Laya is busy; use local fallback")
    try:
        raw = agent.predict(state, {
            "action": {"type": "choice", "instructions": instructions, "criteria": options},
        })
    finally:
        _inference_lock.release()
    answers = raw.get("answers")
    action = answers.get("action") if isinstance(answers, dict) else None
    if not isinstance(action, dict):
        raise RuntimeError("Laya returned no action")
    choice = action.get("choice")
    confidence = action.get("answer_confidence")
    if not isinstance(choice, str) or choice not in options:
        raise RuntimeError("Laya returned an invalid choice")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise RuntimeError("Laya returned no confidence")
    return choice, max(0.0, min(1.0, float(confidence)))


def _risk(payload: dict[str, object]) -> dict[str, object]:
    choice, confidence = _choose(
        payload,
        {
            "low": "Proceed normally; the account and visit context look low risk.",
            "medium": "Proceed with normal pacing and monitoring.",
            "high": "Delay or reduce pacing because the context has elevated risk.",
            "critical": "Do not proceed until an operator or policy gate clears the context.",
        },
        "Choose the safest risk bucket for this visit context.",
    )
    if confidence < 0.75:
        raise RuntimeError("Laya risk confidence is below 0.75; use local fallback")
    score = {"low": 15, "medium": 50, "high": 75, "critical": 95}[choice]
    return {
        "score": score,
        "level": choice,
        "reason": f"Laya selected the {choice} risk bucket with confidence {confidence:.2f}.",
        "shouldProceed": choice in {"low", "medium"},
        "suggestedDelayMs": {"low": 0, "medium": 5000, "high": 15000, "critical": 30000}[choice],
    }


def _campaign(payload: dict[str, object]) -> dict[str, object]:
    choice, confidence = _choose(
        payload,
        {
            "aggressive": "Increase pacing only when recent visits are consistently healthy.",
            "normal": "Keep the current pacing and thread count.",
            "cautious": "Slow pacing and observe the next visits.",
            "pause": "Pause the campaign because failures or risk are too high.",
        },
        "Choose a conservative campaign pacing strategy from the current metrics.",
    )
    return {
        "decision": choice,
        "confidence": confidence,
        "reasoning": "Laya choice adapter; confidence is returned unchanged.",
        "tier": "laya-choice",
    }


def _health(payload: dict[str, object]) -> dict[str, object]:
    choice, confidence = _choose(
        payload,
        {
            "A": "Established account with a clean, stable history.",
            "B": "Healthy account with minor caution signals.",
            "C": "Usable account that should remain under warmup limits.",
            "D": "Risky account that should be cooled down before traffic.",
            "F": "Blocked or unsafe account; do not send traffic.",
        },
        "Choose the account health grade conservatively.",
    )
    score = {"A": 90, "B": 70, "C": 50, "D": 30, "F": 10}[choice]
    result = {
        "score": score,
        "grade": choice,
        "risks": [],
        "recommendations": ["Keep local policy gates authoritative."],
        "readyForTraffic": choice in {"A", "B", "C"},
        "cooldownMs": 0 if choice in {"A", "B", "C"} else 7 * 24 * 60 * 60 * 1000,
        "confidence": confidence,
    }
    return {"decision": json.dumps(result, ensure_ascii=False), "confidence": confidence, "reasoning": json.dumps(result, ensure_ascii=False), "tier": "laya-choice"}


def _completion(payload: dict[str, object]) -> dict[str, object]:
    if payload.get("model") != MODEL_NAME:
        raise ValueError("unsupported model")
    messages = payload.get("messages")
    if not isinstance(messages, list) or len(messages) != 1 or not isinstance(messages[0], dict):
        raise ValueError("exactly one user message is required")
    if messages[0].get("role") != "user":
        raise ValueError("a user message is required")
    content = messages[0].get("content")
    if not isinstance(content, str) or len(content) > MAX_BODY_BYTES:
        raise ValueError("message content must be a bounded JSON string")
    request = json.loads(content)
    if not isinstance(request, dict):
        raise ValueError("request content must be an object")
    request_type = request.get("request_type")
    if request_type == "risk_score":
        result = _risk(request)
    elif request_type == "campaign_optimization":
        result = _campaign(request)
    elif request_type == "account_health_score":
        result = _health(request)
    else:
        raise ValueError("unsupported request_type")
    return {"id": "laya-local", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(result, ensure_ascii=False)}, "finish_reason": "stop"}], "model": MODEL_NAME}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send(self, status: int, body: dict[str, object]) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/api/v1/models":
            self._send(404, {"error": "not_found"})
            return
        self._send(200, {
            "service": SERVICE_NAME,
            "protocol": PROTOCOL_VERSION,
            "pid": os.getpid(),
            "data": [{"id": MODEL_NAME}],
            "version": "laya-0.3.20-local",
            "tier1Ready": True,
            "tier2Ready": False,
            "model_loaded": True,
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/api/v1/chat/completions":
            self._send(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError("request body is too large or empty")
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("request must be an object")
            result = _completion(payload)
            self._send(200, result)
        except Exception as exc:  # noqa: BLE001
            self._send(503, {"error": {"message": str(exc), "type": "laya_unavailable"}})


def main() -> None:
    global HOST, PORT, MODEL_DIR
    for argument in sys.argv[1:]:
        if argument.startswith("--host="):
            HOST = argument.split("=", 1)[1] or HOST
        elif argument.startswith("--port="):
            PORT = int(argument.split("=", 1)[1])
        elif argument.startswith("--model-dir="):
            MODEL_DIR = Path(argument.split("=", 1)[1]).resolve()
    if not MODEL_DIR.exists():
        raise SystemExit(f"Laya model directory is missing: {MODEL_DIR}")
    if HOST != "127.0.0.1" or not 0 <= PORT <= 65535:
        raise SystemExit("Only a valid loopback endpoint is supported")
    _load_agent()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
