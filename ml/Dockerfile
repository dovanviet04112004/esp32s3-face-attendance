# Reproducible training environment, built from uv.lock so an image rebuilt in
# six months installs the same versions.
#
# The lock pins CPU torch: CI has no GPU, and a lock that resolves differently
# per machine is not a lock. Training on a CUDA box needs a CUDA base image and
# its own lock; see the note in ml/README.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /uvx /usr/local/bin/

WORKDIR /workspace

# Dependencies first: they change far less often than the source, so a source
# edit does not invalidate the layer that downloads torch.
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --all-groups

COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --all-groups

CMD ["python", "-c", "import facepipe, torch; print(facepipe.__version__, torch.__version__)"]
