"""Validate the public snapshot before accepting a deployment as ready.

Dates use Python's calendar range (years 0001 through 9999); JavaScript also
accepts year 0000. Errors deliberately exclude all report values.
"""

from datetime import date, datetime
import math
import re


MAX_SAFE = 2**53 - 1
TOKEN_KEYS = ("inputTokens", "outputTokens", "cacheWriteTokens",
              "cacheReadTokens", "totalTokens")
DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
TIMESTAMP = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])\Z"
)


def _invalid():
    raise ValueError("Invalid readiness snapshot")


def _safe_integer(value):
    return (type(value) in (int, float) and 0 <= value <= MAX_SAFE
            and (type(value) is int or math.isfinite(value) and value.is_integer()))


def _finite(value):
    if type(value) not in (int, float) or value < 0:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _totals(value):
    if not isinstance(value, dict):
        _invalid()
    if not all(_safe_integer(value.get(key)) for key in TOKEN_KEYS):
        _invalid()
    if not _finite(value.get("costUsd")):
        _invalid()


def _add(accumulated, value):
    for key in (*TOKEN_KEYS, "otherTokens", "costUsd"):
        total = accumulated.get(key, 0) + value[key]
        if not (_finite(total) if key == "costUsd" else _safe_integer(total)):
            _invalid()
        accumulated[key] = total


def validate_snapshot(value):
    """Return None for a ready snapshot, or raise a content-free ValueError."""
    if not isinstance(value, dict):
        _invalid()
    if (type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or value.get("stale") is not False or "error" in value
            or not _strings(value.get("warnings"))):
        _invalid()
    generated = value.get("generatedAt")
    if not isinstance(generated, str) or not TIMESTAMP.fullmatch(generated):
        _invalid()
    try:
        datetime.fromisoformat(generated.replace("Z", "+00:00"))
    except ValueError:
        _invalid()
    metadata = value.get("metadata")
    if (not isinstance(metadata, dict) or metadata.get("ccusageVersion") != "20.0.33"
            or type(metadata.get("offline")) is not bool
            or metadata.get("pricingMode") != "auto"
            or not _strings(metadata.get("limitations"))):
        _invalid()
    days = value.get("days")
    if not isinstance(days, list):
        _invalid()
    all_days = {}
    models_by_identity = {}
    for day in days:
        _totals(day)
        day_date = day.get("date")
        if not isinstance(day_date, str) or not DATE.fullmatch(day_date):
            _invalid()
        try:
            date.fromisoformat(day_date)
        except ValueError:
            _invalid()
        if not isinstance(day.get("agent"), str) or not day["agent"]:
            _invalid()
        if not isinstance(day.get("models"), list):
            _invalid()
        other_sum = 0
        for model in day["models"]:
            _totals(model)
            if (not isinstance(model.get("model"), str) or not model["model"]
                    or type(model.get("missingPricing")) is not bool
                    or model.get("attribution") not in ("model", "unattributed")):
                _invalid()
            known = sum(model[key] for key in TOKEN_KEYS[:-1])
            other = model.get("otherTokens", max(0, model["totalTokens"] - known))
            if not _safe_integer(other) or known + other != model["totalTokens"]:
                _invalid()
            other_sum += other
            if not _safe_integer(other_sum):
                _invalid()
            identity = (day["agent"], model["model"], model["attribution"])
            _add(models_by_identity.setdefault(identity, {}), {**model, "otherTokens": other})
        _add(all_days, {**day, "otherTokens": other_sum})
