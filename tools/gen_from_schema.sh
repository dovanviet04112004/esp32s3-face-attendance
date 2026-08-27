#!/usr/bin/env bash
#
# Generate the TypeScript DTOs and the firmware payload header from
# contracts/schema. Deterministic: two runs produce byte-identical output, which
# is what the contracts CI job checks with git diff --exit-code.
#
# Usage: ./tools/gen_from_schema.sh [--check]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="write"
if [[ "${1:-}" == "--check" ]]; then
    MODE="check"
fi

python3 - "$ROOT" "$MODE" <<'PYTHON'
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
MODE = sys.argv[2]

SCHEMA_DIR = ROOT / "contracts" / "schema"
BACKEND_OUT = ROOT / "backend" / "src" / "common" / "generated"
FRONTEND_OUT = ROOT / "frontend" / "types" / "generated"
FIRMWARE_OUT = ROOT / "firmware" / "components" / "common" / "include" / "gen_payload.h"

REGENERATE = "./tools/gen_from_schema.sh"
DEFAULT_STRING_LEN = 64

written: list[Path] = []
stale: list[Path] = []


def banner(source: str, comment: str = "//") -> str:
    return (
        f"{comment} GENERATED FILE - DO NOT EDIT.\n"
        f"{comment} Source: {source}\n"
        f"{comment} Regenerate: {REGENERATE}\n"
    )


def pascal(name: str) -> str:
    return "".join(part.capitalize() for part in re.split(r"[_\-\s]+", name) if part)


def snake(name: str) -> str:
    step = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", step).lower()


def screaming(name: str) -> str:
    return snake(name).upper()


def emit(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current != text:
        stale.append(path)
        if MODE == "write":
            path.write_text(text, encoding="utf-8")
    written.append(path)


def int_c_type(spec: dict) -> str:
    lo = spec.get("minimum")
    hi = spec.get("maximum")
    if "enum" in spec:
        values = spec["enum"]
        lo = min(values) if lo is None else lo
        hi = max(values) if hi is None else hi
    if lo is not None and lo >= 0 and hi is not None:
        if hi <= 0xFF:
            return "uint8_t"
        if hi <= 0xFFFF:
            return "uint16_t"
        if hi <= 0xFFFFFFFF:
            return "uint32_t"
    return "int64_t"


def string_len(spec: dict) -> int:
    limit = spec.get("maxLength")
    if limit is None:
        pattern = spec.get("pattern", "")
        match = re.search(r"\{\d+,(\d+)\}", pattern)
        if match:
            limit = int(match.group(1))
    if limit is None and spec.get("format") == "uuid":
        limit = 36
    return (limit or DEFAULT_STRING_LEN) + 1


class Sub:
    def __init__(self, prefix: str, spec: dict):
        self.c_prefix = prefix
        self.schema = spec

    @property
    def properties(self) -> dict:
        return self.schema.get("properties", {})

    @property
    def required(self) -> list:
        return self.schema.get("required", [])


class Model:
    def __init__(self, path: Path):
        self.path = path
        self.source = f"contracts/schema/{path.name}"
        self.schema = json.loads(path.read_text(encoding="utf-8"))
        self.title = self.schema.get("title") or pascal(path.name.split(".")[0])
        self.stem = path.name.split(".")[0]
        self.c_prefix = snake(self.title)

    @property
    def properties(self) -> dict:
        return self.schema.get("properties", {})

    @property
    def required(self) -> list:
        return self.schema.get("required", [])


def ts_type(spec: dict, indent: str) -> str:
    kind = spec.get("type")
    if "enum" in spec and kind == "string":
        return " | ".join(json.dumps(v) for v in spec["enum"])
    if "enum" in spec and kind == "integer":
        return " | ".join(str(v) for v in spec["enum"])
    if kind == "string":
        return "string"
    if kind in ("integer", "number"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "array":
        return f"{ts_type(spec.get('items', {}), indent)}[]"
    if kind == "object":
        inner = ts_fields(spec.get("properties", {}), spec.get("required", []), indent + "  ")
        return "{\n" + inner + indent + "}"
    return "unknown"


def ts_fields(props: dict, required: list, indent: str) -> str:
    out = []
    for name, spec in props.items():
        description = spec.get("description")
        if description:
            out.append(f"{indent}/** {description} */\n")
        optional = "" if name in required else "?"
        out.append(f"{indent}{name}{optional}: {ts_type(spec, indent)};\n")
    return "".join(out)


def render_ts(model: Model) -> str:
    body = ts_fields(model.properties, model.required, "  ")
    description = model.schema.get("description", "")
    doc = f"/** {description} */\n" if description else ""
    return banner(model.source) + "\n" + doc + f"export interface {model.title} {{\n{body}}}\n"


def render_ts_index(models: list[Model]) -> str:
    lines = [f'export * from "./{m.stem}";' for m in models]
    return banner("contracts/schema/") + "\n" + "\n".join(lines) + "\n"


def c_enum_name(model: Model, field: str) -> str:
    return f"{model.c_prefix}_{snake(field)}_t"


def render_c_enums(model: Model) -> str:
    out = []
    for field, spec in model.properties.items():
        if spec.get("type") != "string" or "enum" not in spec:
            continue
        name = c_enum_name(model, field)
        prefix = screaming(f"{model.c_prefix}_{field}")
        entries = "".join(
            f"    {prefix}_{screaming(v)} = {i},\n" for i, v in enumerate(spec["enum"])
        )
        out.append(f"typedef enum {{\n{entries}}} {name};\n\n")
        out.append(f"static inline const char *{name[:-2]}_str({name} v)\n{{\n")
        out.append("    switch (v) {\n")
        for value in spec["enum"]:
            out.append(f'    case {prefix}_{screaming(value)}: return "{value}";\n')
        out.append("    default: return \"\";\n    }\n}\n\n")
        out.append(f"static inline bool {name[:-2]}_parse(const char *s, {name} *out)\n{{\n")
        out.append("    if (s == NULL || out == NULL) { return false; }\n")
        for value in spec["enum"]:
            out.append(
                f'    if (strcmp(s, "{value}") == 0) {{ *out = '
                f"{prefix}_{screaming(value)}; return true; }}\n"
            )
        out.append("    return false;\n}\n\n")
    return "".join(out)


def c_field(model: Model, field: str, spec: dict) -> tuple[str, str]:
    kind = spec.get("type")
    cname = snake(field)
    if kind == "string" and "enum" in spec:
        return f"    {c_enum_name(model, field)} {cname};\n", "enum"
    if kind == "string":
        return f"    char {cname}[{string_len(spec)}];\n", "string"
    if kind == "integer":
        return f"    {int_c_type(spec)} {cname};\n", "integer"
    if kind == "number":
        return f"    float {cname};\n", "number"
    if kind == "boolean":
        return f"    bool {cname};\n", "boolean"
    if kind == "object":
        return f"    {model.c_prefix}_{cname}_t {cname};\n", "object"
    return "", "skip"


def sub_models(model) -> list:
    return [
        Sub(f"{model.c_prefix}_{snake(field)}", spec)
        for field, spec in model.properties.items()
        if spec.get("type") == "object"
    ]


def render_c_struct(model: Model) -> str:
    fields = []
    presence = []
    for field, spec in model.properties.items():
        text, kind = c_field(model, field, spec)
        if kind == "skip":
            continue
        fields.append(text)
        if field not in model.required:
            presence.append(f"    bool has_{snake(field)};\n")
    body = "".join(fields) + "".join(presence)
    return f"typedef struct {{\n{body}}} {model.c_prefix}_t;\n\n"


def render_c_parse(model: Model) -> str:
    name = model.c_prefix
    out = [
        f"static inline bool {name}_from_json(const cJSON *root, {name}_t *out)\n{{\n",
        "    if (root == NULL || out == NULL) { return false; }\n",
        f"    memset(out, 0, sizeof(*out));\n",
        "    const cJSON *item = NULL;\n",
    ]
    for field, spec in model.properties.items():
        _, kind = c_field(model, field, spec)
        if kind == "skip":
            continue
        cname = snake(field)
        required = field in model.required
        out.append(f'    item = cJSON_GetObjectItemCaseSensitive(root, "{field}");\n')
        if kind == "string":
            cond = "cJSON_IsString(item) && item->valuestring != NULL"
            body = (
                f"        strncpy(out->{cname}, item->valuestring, "
                f"sizeof(out->{cname}) - 1);\n"
            )
        elif kind == "enum":
            enum_fn = c_enum_name(model, field)[:-2]
            cond = "cJSON_IsString(item) && item->valuestring != NULL"
            body = f"        if (!{enum_fn}_parse(item->valuestring, &out->{cname})) "
            body += "{ return false; }\n"
        elif kind == "boolean":
            cond = "cJSON_IsBool(item)"
            body = f"        out->{cname} = cJSON_IsTrue(item);\n"
        elif kind == "number":
            cond = "cJSON_IsNumber(item)"
            body = f"        out->{cname} = (float) item->valuedouble;\n"
        elif kind == "object":
            cond = "cJSON_IsObject(item)"
            body = (
                f"        if (!{model.c_prefix}_{cname}_from_json(item, &out->{cname})) "
                "{ return false; }\n"
            )
        else:
            ctype = int_c_type(spec)
            cond = "cJSON_IsNumber(item)"
            body = f"        out->{cname} = ({ctype}) item->valuedouble;\n"
        out.append(f"    if ({cond}) {{\n{body}")
        if not required:
            out.append(f"        out->has_{cname} = true;\n")
        out.append("    }")
        if required:
            out.append(" else {\n        return false;\n    }\n")
        else:
            out.append("\n")
    out.append("    return true;\n}\n\n")
    return "".join(out)


def render_c_serialize(model: Model) -> str:
    name = model.c_prefix
    out = [
        f"static inline cJSON *{name}_to_json(const {name}_t *in)\n{{\n",
        "    if (in == NULL) { return NULL; }\n",
        "    cJSON *root = cJSON_CreateObject();\n",
        "    if (root == NULL) { return NULL; }\n",
    ]
    for field, spec in model.properties.items():
        _, kind = c_field(model, field, spec)
        if kind == "skip":
            continue
        cname = snake(field)
        required = field in model.required
        indent = "    " if required else "        "
        if not required:
            out.append(f"    if (in->has_{cname}) {{\n")
        if kind == "string":
            out.append(f'{indent}cJSON_AddStringToObject(root, "{field}", in->{cname});\n')
        elif kind == "enum":
            enum_fn = c_enum_name(model, field)[:-2]
            out.append(
                f'{indent}cJSON_AddStringToObject(root, "{field}", '
                f"{enum_fn}_str(in->{cname}));\n"
            )
        elif kind == "boolean":
            out.append(f'{indent}cJSON_AddBoolToObject(root, "{field}", in->{cname});\n')
        elif kind == "object":
            out.append(
                f'{indent}cJSON_AddItemToObject(root, "{field}", '
                f"{model.c_prefix}_{cname}_to_json(&in->{cname}));\n"
            )
        else:
            out.append(
                f'{indent}cJSON_AddNumberToObject(root, "{field}", (double) in->{cname});\n'
            )
        if not required:
            out.append("    }\n")
    out.append("    return root;\n}\n\n")
    return "".join(out)


def render_header(models: list[Model]) -> str:
    parts = [
        banner("contracts/schema/"),
        "\n#pragma once\n\n",
        "#include <stdbool.h>\n#include <stdint.h>\n#include <string.h>\n\n",
        '#include "cJSON.h"\n\n',
        "#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n",
    ]
    for model in models:
        for sub in sub_models(model):
            parts.append(render_c_enums(sub))
            parts.append(render_c_struct(sub))
            parts.append(render_c_parse(sub))
            parts.append(render_c_serialize(sub))
        parts.append(render_c_enums(model))
        parts.append(render_c_struct(model))
        parts.append(render_c_parse(model))
        parts.append(render_c_serialize(model))
    parts.append("#ifdef __cplusplus\n}\n#endif\n")
    return "".join(parts)


schemas = sorted(SCHEMA_DIR.glob("*.schema.json"))
if not schemas:
    print(f"no schema found in {SCHEMA_DIR}", file=sys.stderr)
    raise SystemExit(1)

models = [Model(p) for p in schemas]

for model in models:
    text = render_ts(model)
    emit(BACKEND_OUT / f"{model.stem}.ts", text)
    emit(FRONTEND_OUT / f"{model.stem}.ts", text)

index = render_ts_index(models)
emit(BACKEND_OUT / "index.ts", index)
emit(FRONTEND_OUT / "index.ts", index)
emit(FIRMWARE_OUT, render_header(models))

for path in written:
    print(path.relative_to(ROOT))

if MODE == "check" and stale:
    print(f"gen_from_schema: {len(stale)} file(s) out of date", file=sys.stderr)
    raise SystemExit(1)

print(f"gen_from_schema: {len(written)} file(s) generated", file=sys.stderr)
PYTHON
