#!/usr/bin/env python3
"""Generate the firmware headers and the TypeScript sources from `contracts/`.

Two sources feed five outputs: `schema/` gives the payload types, and
`mqtt_topics.yaml` gives the topic table. Output is deterministic, which is what
`ci/contracts.yml` checks by regenerating and running `git diff --exit-code`.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

SCHEMA_DIR = ROOT / "contracts" / "schema"
TOPICS_FILE = ROOT / "contracts" / "mqtt_topics.yaml"
BACKEND_OUT = ROOT / "backend" / "src" / "common" / "generated"
FRONTEND_OUT = ROOT / "frontend" / "types" / "generated"
FIRMWARE_OUT = ROOT / "firmware" / "components" / "common" / "include"

REGENERATE = "./tools/gen_contracts.py"
DEFAULT_STRING_LEN = 64
DEVICE_ID_PLACEHOLDER = "{deviceId}"
DEVICE_ID_FALLBACK_MAX = 32


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
        match = re.search(r"\{\d+,(\d+)\}", spec.get("pattern", ""))
        if match:
            limit = int(match.group(1))
    if limit is None and spec.get("format") == "uuid":
        limit = 36
    return (limit or DEFAULT_STRING_LEN) + 1


class Sub:
    """One nested object property, rendered as its own struct and codec."""

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
    """One `*.schema.json` file, named after its `title`."""

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


class Topic:
    """One entry of `mqtt_topics.yaml`, with the wire settings it carries."""

    def __init__(self, spec: dict):
        self.name = spec["name"]
        self.template = spec["topic"]
        self.direction = spec["direction"]
        self.qos = int(spec.get("qos", 0))
        self.retained = bool(spec.get("retained", False))
        self.last_will = bool(spec.get("last_will", False))
        self.interval_s = spec.get("interval_seconds")
        self.schema = spec.get("schema")
        self.c_name = snake(self.name)
        self.c_upper = screaming(self.name)

    def rendered_len(self, device_id_max: int) -> int:
        return len(self.template) - len(DEVICE_ID_PLACEHOLDER) + device_id_max

    def c_parts(self) -> tuple[str, str]:
        head, _, tail = self.template.partition(DEVICE_ID_PLACEHOLDER)
        return head, tail


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
        "    memset(out, 0, sizeof(*out));\n",
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


def render_payload_header(models: list[Model]) -> str:
    parts = [
        banner("contracts/schema/"),
        "\n#pragma once\n\n",
        "#include <stdbool.h>\n#include <stdint.h>\n#include <string.h>\n\n",
        '#include "cJSON.h"\n\n',
        '#ifdef __cplusplus\nextern "C" {\n#endif\n\n',
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


def device_id_max(models: list[Model]) -> int:
    """Longest deviceId the schemas admit, so the topic buffer cannot come up short."""
    limits = []
    for model in models:
        spec = model.properties.get("deviceId")
        if spec is not None:
            limits.append(string_len(spec) - 1)
    return max(limits) if limits else DEVICE_ID_FALLBACK_MAX


def render_topics_header(topics: list[Topic], id_max: int) -> str:
    longest = max(t.rendered_len(id_max) for t in topics)
    parts = [
        banner("contracts/mqtt_topics.yaml"),
        "\n#pragma once\n\n",
        "#include <stdbool.h>\n#include <stddef.h>\n#include <stdint.h>\n#include <string.h>\n\n",
        '#ifdef __cplusplus\nextern "C" {\n#endif\n\n',
        f"#define GEN_TOPIC_DEVICE_ID_MAX {id_max}\n",
        f"#define GEN_TOPIC_MAX_LEN {longest + 1}\n\n",
    ]

    entries = "".join(
        f"    GEN_TOPIC_{t.c_upper} = {i},\n" for i, t in enumerate(topics)
    )
    parts.append(f"typedef enum {{\n{entries}    GEN_TOPIC_NONE = {len(topics)},\n")
    parts.append("} gen_topic_id_t;\n\n")

    for topic in topics:
        parts.append(f"#define GEN_TOPIC_{topic.c_upper}_QOS {topic.qos}\n")
        parts.append(
            f"#define GEN_TOPIC_{topic.c_upper}_RETAIN "
            f"{'true' if topic.retained else 'false'}\n"
        )
        parts.append(
            f"#define GEN_TOPIC_{topic.c_upper}_IS_LAST_WILL "
            f"{'true' if topic.last_will else 'false'}\n"
        )
        if topic.interval_s is not None:
            parts.append(
                f"#define GEN_TOPIC_{topic.c_upper}_INTERVAL_S {int(topic.interval_s)}\n"
            )
    parts.append("\n")

    for topic in topics:
        head, tail = topic.c_parts()
        parts.append(
            f"static inline bool gen_topic_{topic.c_name}(const char *device_id, "
            "char *out, size_t cap)\n{\n"
        )
        parts.append("    if (device_id == NULL || out == NULL) { return false; }\n")
        parts.append("    const size_t id_len = strlen(device_id);\n")
        parts.append(f"    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) {{ return false; }}\n")
        parts.append(
            f"    const size_t need = {len(head)} + id_len + {len(tail)} + 1;\n"
        )
        parts.append("    if (cap < need) { return false; }\n")
        parts.append(f'    memcpy(out, "{head}", {len(head)});\n')
        parts.append(f"    memcpy(out + {len(head)}, device_id, id_len);\n")
        parts.append(
            f'    memcpy(out + {len(head)} + id_len, "{tail}", {len(tail)} + 1);\n'
        )
        parts.append("    return true;\n}\n\n")

    parts.append(
        "static inline gen_topic_id_t gen_topic_classify(const char *topic, "
        "const char *device_id)\n{\n"
    )
    parts.append("    if (topic == NULL || device_id == NULL) { return GEN_TOPIC_NONE; }\n")
    parts.append("    char built[GEN_TOPIC_MAX_LEN];\n")
    for topic in topics:
        parts.append(
            f"    if (gen_topic_{topic.c_name}(device_id, built, sizeof(built)) && "
            f"strcmp(topic, built) == 0) {{ return GEN_TOPIC_{topic.c_upper}; }}\n"
        )
    parts.append("    return GEN_TOPIC_NONE;\n}\n\n")

    down = [t for t in topics if t.direction == "down"]
    parts.append(f"#define GEN_TOPIC_DOWN_COUNT {len(down)}\n\n")
    parts.append(
        "static inline gen_topic_id_t gen_topic_down_at(size_t index)\n{\n"
        "    switch (index) {\n"
    )
    for i, topic in enumerate(down):
        parts.append(f"    case {i}: return GEN_TOPIC_{topic.c_upper};\n")
    parts.append("    default: return GEN_TOPIC_NONE;\n    }\n}\n\n")

    parts.append(
        "static inline bool gen_topic_build(gen_topic_id_t id, const char *device_id, "
        "char *out, size_t cap)\n{\n    switch (id) {\n"
    )
    for topic in topics:
        parts.append(
            f"    case GEN_TOPIC_{topic.c_upper}: "
            f"return gen_topic_{topic.c_name}(device_id, out, cap);\n"
        )
    parts.append("    default: return false;\n    }\n}\n\n")

    parts.append("static inline uint8_t gen_topic_qos(gen_topic_id_t id)\n{\n    switch (id) {\n")
    for topic in topics:
        parts.append(
            f"    case GEN_TOPIC_{topic.c_upper}: return GEN_TOPIC_{topic.c_upper}_QOS;\n"
        )
    parts.append("    default: return 0;\n    }\n}\n\n")

    parts.append("static inline bool gen_topic_retain(gen_topic_id_t id)\n{\n    switch (id) {\n")
    for topic in topics:
        parts.append(
            f"    case GEN_TOPIC_{topic.c_upper}: return GEN_TOPIC_{topic.c_upper}_RETAIN;\n"
        )
    parts.append("    default: return false;\n    }\n}\n\n")

    parts.append("#ifdef __cplusplus\n}\n#endif\n")
    return "".join(parts)


def render_topics_ts(topics: list[Topic], id_max: int) -> str:
    parts = [
        banner("contracts/mqtt_topics.yaml"),
        "\n",
        f"export const DEVICE_ID_MAX_LEN = {id_max};\n\n",
        "export type TopicName =\n",
    ]
    parts.append("".join(f"  | {json.dumps(t.name)}\n" for t in topics))
    parts.append(";\n\nexport interface TopicSpec {\n")
    parts.append("  readonly name: TopicName;\n")
    parts.append('  readonly direction: "up" | "down";\n')
    parts.append("  readonly qos: 0 | 1 | 2;\n")
    parts.append("  readonly retained: boolean;\n")
    parts.append("  readonly lastWill: boolean;\n")
    parts.append("  build(deviceId: string): string;\n")
    parts.append("  readonly wildcard: string;\n")
    parts.append("}\n\n")
    parts.append("export const TOPICS: { readonly [K in TopicName]: TopicSpec } = {\n")
    for topic in topics:
        head, tail = topic.c_parts()
        wildcard = f"{head}+{tail}"
        head_tpl = head.replace("`", "\\`")
        tail_tpl = tail.replace("`", "\\`")
        parts.append(f"  {json.dumps(topic.name)}: {{\n")
        parts.append(f"    name: {json.dumps(topic.name)},\n")
        parts.append(f"    direction: {json.dumps(topic.direction)},\n")
        parts.append(f"    qos: {topic.qos},\n")
        parts.append(f"    retained: {str(topic.retained).lower()},\n")
        parts.append(f"    lastWill: {str(topic.last_will).lower()},\n")
        parts.append(
            f"    build: (deviceId: string) => `{head_tpl}${{deviceId}}{tail_tpl}`,\n"
        )
        parts.append(f"    wildcard: {json.dumps(wildcard)},\n")
        parts.append("  },\n")
    parts.append("};\n")
    return "".join(parts)


def load_topics() -> list[Topic]:
    spec = yaml.safe_load(TOPICS_FILE.read_text(encoding="utf-8"))
    topics = [Topic(entry) for entry in spec["topics"]]
    for topic in topics:
        if DEVICE_ID_PLACEHOLDER not in topic.template:
            raise SystemExit(f"topic {topic.name} has no {DEVICE_ID_PLACEHOLDER}")
    names = [t.c_name for t in topics]
    if len(set(names)) != len(names):
        raise SystemExit("two topics collapse to the same C identifier")
    return topics


def main() -> int:
    check_only = "--check" in sys.argv[1:]
    written: list[Path] = []
    stale: list[Path] = []

    def emit(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current != text:
            stale.append(path)
            if not check_only:
                path.write_text(text, encoding="utf-8")
        written.append(path)

    schemas = sorted(SCHEMA_DIR.glob("*.schema.json"))
    if not schemas:
        print(f"no schema found in {SCHEMA_DIR}", file=sys.stderr)
        return 1
    models = [Model(p) for p in schemas]
    topics = load_topics()
    id_max = device_id_max(models)

    for model in models:
        text = render_ts(model)
        emit(BACKEND_OUT / f"{model.stem}.ts", text)
        emit(FRONTEND_OUT / f"{model.stem}.ts", text)

    index = render_ts_index(models)
    emit(BACKEND_OUT / "index.ts", index)
    emit(FRONTEND_OUT / "index.ts", index)
    emit(FIRMWARE_OUT / "gen_payload.h", render_payload_header(models))
    emit(FIRMWARE_OUT / "gen_topics.h", render_topics_header(topics, id_max))
    emit(BACKEND_OUT / "topics.ts", render_topics_ts(topics, id_max))

    for path in written:
        print(path.relative_to(ROOT))

    if check_only and stale:
        print(f"gen_contracts: {len(stale)} file(s) out of date", file=sys.stderr)
        return 1

    print(f"gen_contracts: {len(written)} file(s) generated", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
