.DEFAULT_GOAL := help
.PHONY: help gen lint check test \
        train-det train-spoof train-recog quantize export golden pack \
        fw-dev fw-bench fw-prod flash monitor \
        be-dev fe-dev up down

SDKCONFIG_BASE := sdkconfig.defaults;sdkconfig.defaults.esp32s3

help:
	@grep -E '^[a-z0-9-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	 awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

# contracts
gen: ## Generate TS DTOs and gen_payload.h from contracts/schema
	./tools/gen_from_schema.sh

# checks
lint: ## check_comments + check_layers + ruff + eslint
	python3 tools/check_comments.py
	python3 tools/check_layers.py
	cd ml && uv run ruff check .
	cd backend && npm run lint
	cd frontend && npm run lint

check: gen ## Regenerate and fail if the committed output drifted
	git diff --exit-code

test: ## Host-side tests for ml/ and backend/
	cd ml && uv run pytest
	cd backend && npm test

# ml
train-det: ## Distill the detection student
	cd ml && uv run python -m facepipe.tasks.detection.train_kd --cfg configs/detection/kd.yaml

train-spoof: ## Distill the anti-spoof student
	cd ml && uv run python -m facepipe.tasks.antispoof.train_kd --cfg configs/antispoof/kd.yaml

train-recog: ## Distill the recognition student
	cd ml && uv run python -m facepipe.tasks.recognition.train_kd --cfg configs/recognition/kd.yaml

quantize: ## Run the Q0..Q10 quantization ladder
	cd ml && ./scripts/30_quantize.sh

export: ## ONNX to INT8 TFLite, then update contracts/models.lock.json
	cd ml && ./scripts/40_export.sh

golden: ## Emit golden vectors into contracts/golden/
	cd ml && ./scripts/41_emit_golden.sh

pack: ## Pack the three .tflite into models.bin and write the partition
	cd ml && ./scripts/50_pack_and_flash.sh

# firmware build profiles
fw-dev: ## Build the dev profile
	cd firmware && idf.py -D SDKCONFIG_DEFAULTS="$(SDKCONFIG_BASE);sdkconfig.dev" build

fw-bench: ## Build the bench profile
	cd firmware && idf.py -D SDKCONFIG_DEFAULTS="$(SDKCONFIG_BASE);sdkconfig.bench" build

fw-prod: ## Build the prod profile
	cd firmware && idf.py -D SDKCONFIG_DEFAULTS="$(SDKCONFIG_BASE);sdkconfig.prod" build

flash: ## Flash and monitor the dev profile
	cd firmware && idf.py -D SDKCONFIG_DEFAULTS="$(SDKCONFIG_BASE);sdkconfig.dev" flash monitor

monitor: ## Open the serial monitor
	cd firmware && idf.py monitor

# backend / frontend / deploy
be-dev: ## Run NestJS in watch mode
	cd backend && npm run start:dev

fe-dev: ## Run the Next.js dev server
	cd frontend && npm run dev

up: ## Bring the docker stack up
	cd deploy && docker compose up -d

down: ## Tear the docker stack down
	cd deploy && docker compose down
