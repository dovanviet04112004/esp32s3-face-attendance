.DEFAULT_GOAL := help
SHELL := /bin/bash
.PHONY: help setup ml-sync ml-lock be-install fe-install \
        gen check lint fmt typecheck be-typecheck fe-typecheck test ml-test ml-cov be-test be-e2e \
        data-fetch data-interim data-splits \
        train-det train-spoof train-recog trainctl quantize export golden pack eval-det eval-spoof eval-recog \
        idf fw-secrets fw-dev fw-bench fw-prod fw-fleet fw-size flash monitor fw-log fw-part-read fw-part-write fw-part-erase fw-app fw-app-flash \
        usb-list usb-attach usb-detach \
        be-dev be-build be-prisma be-migrate be-seed be-demo fe-dev fe-build \
        up down ml-docker ml-clean

# uv lives in ~/.local/bin, which the login shell here leaves off PATH.
UV ?= $(or $(shell command -v uv 2>/dev/null),$(HOME)/.local/bin/uv)
ML_PY := $(CURDIR)/ml/.venv/bin/python
# One torch build per box (pyproject): cu130 on the GPU machine, TORCH=cpu elsewhere.
TORCH ?= cu130
ML_EXTRAS := --extra $(TORCH) --extra export --extra espdl --extra bench --extra eval
USBIPD ?= usbipd.exe
# WSL here has no docker of its own; Docker Desktop's client stands in.
DOCKER ?= $(or $(shell command -v docker 2>/dev/null),/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe)
# The e2e clone stays outside the tree: the repo's backend/.env would otherwise reach the suites.
E2E_DIR ?= $(HOME)/.cache/kiosk-e2e
CONC ?= 3
PORT_FLAG := $(if $(PORT),-p $(PORT))
# Each firmware profile builds in its own folder from its own sdkconfig (KEHOACH 4.5.9).
PROFILE ?= dev
# The release job's profile while the repo variable is unset (KEHOACH 7.7).
FLEET_PROFILE ?= prod
FW_BASE := sdkconfig.defaults sdkconfig.defaults.esp32s3
# The batch token rides in only when the builder holds it (KEHOACH 4.5.9).
FW_SECRETS := $(if $(wildcard firmware/sdkconfig.secrets),sdkconfig.secrets)
fw_dir_dev := build
fw_dir_bench := build_bench
fw_dir_prod := build_prod
fw_dir_fleet := build_release
fw_cfg_dev := sdkconfig
fw_cfg_bench := build_bench/sdkconfig
fw_cfg_prod := build_prod/sdkconfig
fw_cfg_fleet := build_release/sdkconfig
fw_set_dev := sdkconfig.dev $(FW_SECRETS)
fw_set_bench := sdkconfig.bench $(FW_SECRETS)
fw_set_prod := sdkconfig.prod sdkconfig.secrets
fw_set_fleet := sdkconfig.$(FLEET_PROFILE) sdkconfig.fleet sdkconfig.secrets
empty :=
space := $(empty) $(empty)
fw_idf = cd firmware && idf.py -B $(fw_dir_$(1)) -D SDKCONFIG=$(fw_cfg_$(1)) \
  -D SDKCONFIG_DEFAULTS="$(subst $(space),;,$(strip $(FW_BASE) $(fw_set_$(1))))"
# Defaults only fill the keys an sdkconfig lacks, so one older than any of its defaults goes.
fw_fresh = @for f in $(FW_BASE) $(fw_set_$(1)); do \
  [ firmware/$$f -nt firmware/$(fw_cfg_$(1)) ] && rm -f firmware/$(fw_cfg_$(1)); done; true
fw_profile = $(if $(fw_dir_$(PROFILE)),,$(error PROFILE must be dev, bench, prod or fleet))
JOBS ?= 4
# idf.py takes no -j, and ninja's default of cores + 2 has crashed this WSL: configure, then ninja.
fw_build = $(call fw_idf,$(1)) reconfigure && ninja -C $(fw_dir_$(1)) -j$(JOBS)
MONITOR ?= monitor
LOG_S ?= 30
# Partitions are found in the table the board holds, unless PART_TABLE names a csv.
parttool = python $(IDF_PATH)/components/partition_table/parttool.py $(if $(PORT),--port $(PORT)) \
  $(if $(PART_TABLE),--partition-table-file $(PART_TABLE))

need = $(if $($(1)),,$(error $(1) is missing: $(2)))

help: ## List every target
	@awk 'BEGIN {FS = ":[^#]*## "} /^##@ / {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} /^[a-z0-9-]+:[^#]*## / {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

##@ Setup
setup: ml-sync be-install fe-install ## Install the dependencies of every block

ml-sync: ## Sync ml/.venv to uv.lock with every extra this box uses
	cd ml && $(UV) sync --frozen $(ML_EXTRAS)

ml-lock: ## Re-resolve ml/uv.lock after editing ml/pyproject.toml
	cd ml && $(UV) lock

be-install: ## Install backend/ from its lockfile
	cd backend && npm ci

fe-install: ## Install frontend/ from its lockfile
	cd frontend && npm ci

##@ Contracts and checks
gen: ## Generate DTOs and firmware headers from contracts/
	python3 tools/gen_contracts.py

check: ## Regenerate from contracts/ and fail if a committed file drifted
	set -o pipefail; python3 tools/gen_contracts.py | xargs git diff --exit-code --

lint: ## Every static check CI runs: the repo tools and ruff
	python3 tools/check_comments.py
	python3 tools/check_layers.py
	python3 tools/check_schematic.py
	python3 tools/check_pcb.py
	python3 tools/check_error_codes.py
	python3 tools/check_migrations.py
	python3 tools/check_routes.py
	python3 tools/gen_sw_words.py --check
	python3 tools/check_notice_kinds.py
	cd ml && $(ML_PY) -m ruff check . && $(ML_PY) -m ruff format --check .

fmt: ## Apply ruff fixes and formatting to ml/
	cd ml && $(ML_PY) -m ruff check --fix . && $(ML_PY) -m ruff format .

typecheck: be-typecheck fe-typecheck ## tsc over backend/ and frontend/, as CI runs it

be-typecheck: ## tsc over backend/
	cd backend && npm run typecheck

fe-typecheck: ## Route types, then tsc over frontend/
	cd frontend && npm run typecheck

test: ml-test be-test ## Host-side tests of ml/ and backend/

ml-test: ## pytest over ml/
	cd ml && $(ML_PY) -m pytest

ml-cov: ## pytest with a coverage report of facepipe.core
	cd ml && $(ML_PY) -m pytest --cov=facepipe.core --cov-report=term-missing

be-test: ## Backend e2e suite, against the Postgres and Redis backend/.env names
	cd backend && npm test

be-e2e: ## Backend e2e as CI runs it: throwaway stack, clean clone plus the working diff (SPECS="x.e2e-spec ...", CONC=3)
	@mkdir -p "$(dir $(E2E_DIR))"
	@set -euo pipefail; exec 9>"$(E2E_DIR).lock"; flock 9; \
	d="$(DOCKER)"; clone="$(E2E_DIR)"; repo="$(CURDIR)"; \
	stop() { "$$d" rm -f ci-e2e-pg ci-e2e-redis ci-e2e-emqx >/dev/null 2>&1 || true; }; trap stop EXIT; stop; \
	"$$d" run -d --rm --name ci-e2e-pg -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=attendance_ci \
	  -p 55462:5432 postgres:16-alpine >/dev/null; \
	"$$d" run -d --rm --name ci-e2e-redis -p 56392:6379 redis:7-alpine >/dev/null; \
	"$$d" run -d --rm --name ci-e2e-emqx -p 51892:1883 -p 58092:18083 emqx/emqx:6.3.1 >/dev/null; \
	rm -rf "$$clone"; git clone -q --no-hardlinks "$$repo" "$$clone"; \
	git diff HEAD | (cd "$$clone" && git apply --allow-empty); \
	git ls-files --others --exclude-standard -- backend contracts | while read -r f; do \
	  mkdir -p "$$clone/$$(dirname "$$f")"; cp "$$f" "$$clone/$$f"; done; \
	cd "$$clone/backend"; cp -al "$$repo/backend/node_modules" node_modules; rm -rf node_modules/.prisma; \
	sed -i 's|:18083|:58092|g' test/*.ts; \
	export NODE_ENV=test DATABASE_URL=postgresql://ci:ci@localhost:55462/attendance_ci REDIS_URL=redis://localhost:56392 \
	  JWT_ACCESS_SECRET=ci-only-access-secret-0123456789abcdef JWT_REFRESH_SECRET=ci-only-refresh-secret-0123456789abcdef \
	  JWT_DEVICE_SECRET=ci-only-device-secret-0123456789abcdef DEVICE_BOOTSTRAP_TOKEN=ci-only-bootstrap-token \
	  TEMPLATE_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= SEED_ADMIN_PASSWORD=ci-only-admin-password \
	  CORS_ORIGIN=http://localhost:3001 APP_PUBLIC_URL=http://localhost:3001 \
	  MQTT_URL=mqtt://localhost:51892 MQTT_USERNAME=ci MQTT_PASSWORD=ci \
	  EMQX_API_URL=http://localhost:58092/api/v5 EMQX_API_PASSWORD=public \
	  LOGIN_ATTEMPTS_PER_MINUTE=100000 API_REQUESTS_PER_MINUTE=100000 HEAVY_REQUESTS_PER_MINUTE=100000 \
	  SEARCH_REQUESTS_PER_MINUTE=100000 DEVICE_REGISTER_ATTEMPTS_PER_MINUTE=100000 FORGOT_ATTEMPTS_PER_HOUR=100000 \
	  LOGIN_IP_MISSES=100000 LOGIN_LOCK_AFTER=100 MAIL_HOST=127.0.0.1 MAIL_PORT=2525 MAIL_FROM=no-reply@example.com; \
	for i in $$(seq 60); do "$$d" exec ci-e2e-pg pg_isready -q -U ci && break; sleep 1; done; \
	for i in $$(seq 60); do (echo >/dev/tcp/127.0.0.1/55462) 2>/dev/null && (echo >/dev/tcp/127.0.0.1/56392) 2>/dev/null && break; sleep 1; done; \
	npx prisma generate >/dev/null; npx prisma migrate deploy >/dev/null; npx prisma db seed >/dev/null; \
	rm -rf dist-test; npx tsc -p tsconfig.json --outDir dist-test; \
	for i in $$(seq 60); do curl -s -o /dev/null http://localhost:58092/ && break; sleep 2; done; \
	if [ -n "$(SPECS)" ]; then node --test --test-concurrency=1 $(foreach s,$(SPECS),dist-test/test/$(s).js); \
	else node --test --test-concurrency=$(CONC) 'dist-test/test/**/*.e2e-spec.js' && \
	  node --test --test-concurrency=1 'dist-test/test/**/*.e2e-alone-spec.js'; fi

##@ ML data
data-fetch: ## Fetch and verify the raw datasets (ARGS=--verify only verifies)
	cd ml && ./scripts/00_fetch_raw.sh $(ARGS)

data-interim: ## raw to interim (ARGS=<branch> for one, ARGS=--force to redo)
	cd ml && ./scripts/01_prepare_interim.sh $(ARGS)

data-splits: ## Split files and SPLIT.md of every branch (ARGS=<branch> for one)
	cd ml && ./scripts/02_make_splits.sh $(ARGS)

##@ ML train, compress, export
train-det: ## Train detection (ARGS="<config> key=value ...")
	cd ml && ./scripts/20_train_det.sh $(ARGS)

train-spoof: ## Train anti-spoof (ARGS="<config> key=value ...")
	cd ml && ./scripts/21_train_spoof.sh $(ARGS)

train-recog: ## Train recognition (ARGS="<config> key=value ...")
	cd ml && ./scripts/22_train_recog.sh $(ARGS)

trainctl: ## Start, pause, resume or check a branch's training (ARGS="check detection")
	cd ml && ./scripts/trainctl.sh $(ARGS)

quantize: ## Q0 and Q1 rungs, TFLite and ESP-DL, of RUN="<run directory> ..."
	$(call need,RUN,make quantize RUN=artifacts/<branch>/runs/<run>)
	cd ml && ./scripts/30_quantize.sh $(RUN)

export: ## Deploy one exported model and lock it (BRANCH MODEL RUN_ID ARENA_BYTES)
	$(call need,BRANCH,detection | antispoof | recognition)
	$(call need,MODEL,the exported .tflite or .espdl)
	$(call need,RUN_ID,<branch>/<run directory name>)
	$(call need,ARENA_BYTES,measured arena of a .tflite; 0 for .espdl)
	$(ML_PY) -m facepipe.export.update_lock --branch $(BRANCH) --model $(MODEL) \
	  --run-id $(RUN_ID) --arena-bytes $(ARENA_BYTES)

eval-det: ## Score detection (AP on WIDER val; ARGS passed to its eval, see ARGS=--help)
	cd ml && $(ML_PY) -m facepipe.tasks.detection.eval $(ARGS)

eval-spoof: ## Score anti-spoof (ARGS passed to its eval)
	cd ml && $(ML_PY) -m facepipe.tasks.antispoof.eval $(ARGS)

eval-recog: ## Score recognition: LFW, CFP-FP, AgeDB, TAR@FAR (ARGS passed to its eval)
	cd ml && $(ML_PY) -m facepipe.tasks.recognition.eval $(ARGS)

golden: ## Golden vectors of the three branches into contracts/golden/
	$(ML_PY) -m facepipe.tasks.detection.postproc.emit_golden
	$(ML_PY) -m facepipe.tasks.antispoof.postproc.emit_golden
	$(ML_PY) -m facepipe.tasks.recognition.postproc.emit_golden

pack: ## Pack the locked models into models.bin (PORT= also writes both slots)
	cd ml && ./scripts/50_pack_and_flash.sh $(if $(PORT),--port $(PORT))

##@ Firmware (source $IDF_PATH/export.sh first; PORT=/dev/ttyACM0 picks the port)
idf:
	@command -v idf.py >/dev/null || { echo "idf.py not found: source \$$IDF_PATH/export.sh"; exit 1; }

fw-secrets:
	@test -f firmware/sdkconfig.secrets || { \
	  echo "firmware/sdkconfig.secrets is missing: this kiosk could never register"; exit 1; }

fw-dev: idf ## Build the dev profile in firmware/build
	$(call fw_fresh,dev)
	$(call fw_build,dev)

fw-bench: idf ## Build the bench profile in firmware/build_bench
	$(call fw_fresh,bench)
	$(call fw_build,bench)

fw-prod: idf fw-secrets ## Build the prod profile in firmware/build_prod, from a fresh sdkconfig
	rm -f firmware/$(fw_cfg_prod)
	$(call fw_build,prod)

fw-fleet: idf fw-secrets ## Build the release image as CI does: FLEET_PROFILE plus sdkconfig.fleet
	rm -f firmware/$(fw_cfg_fleet)
	$(call fw_build,fleet)

fw-size: idf ## Size report of a built profile (PROFILE=dev|bench|prod|fleet)
	$(fw_profile)
	$(call fw_idf,$(PROFILE)) size

flash: idf ## Flash a built profile, then the monitor (PROFILE=dev|bench|prod|fleet, MONITOR= skips it)
	$(fw_profile)
	cd firmware && ninja -C $(fw_dir_$(PROFILE)) -j$(JOBS)
	$(call fw_idf,$(PROFILE)) $(PORT_FLAG) flash $(MONITOR)

monitor: idf ## Open the serial monitor
	cd firmware && idf.py $(PORT_FLAG) monitor

# idf.py monitor refuses a stdin that is no terminal, so script lends it one.
fw-log: idf ## Print the board's console for LOG_S seconds (30), reset first unless NORESET=1; APP= for a test app
	$(fw_profile)
	-timeout $(LOG_S) script -qfec "cd $(if $(APP),$(APP) && idf.py,firmware && idf.py -B $(fw_dir_$(PROFILE))) \
	  $(PORT_FLAG) monitor $(if $(NORESET),--no-reset)" /dev/null

# The monitor forwards what script feeds it, so the command goes in once the console is listening.
fw-console: idf ## Type CMD into the running board's console and print LOG_S seconds of the reply (PORT=; APP= for a test app's menu)
	$(call need,CMD,a console command such as heap)
	$(fw_profile)
	-(sleep 3; printf '%s\r' '$(CMD)'; sleep $(LOG_S)) | timeout $$(($(LOG_S) + 6)) script -qfec \
	  "cd $(if $(APP),$(APP) && idf.py,firmware && idf.py -B $(fw_dir_$(PROFILE))) $(PORT_FLAG) monitor --no-reset" /dev/null

fw-mac: idf ## Print the MAC of the board on PORT, which names it: kiosk-<mac without colons>
	esptool $(if $(PORT),--port $(PORT)) --chip esp32s3 read-mac

fw-part-read: idf ## Save partition PART of the board into the file OUT (PORT=)
	$(call need,PART,a partition name such as models_0)
	$(call need,OUT,the file to write)
	$(parttool) read_partition --partition-name $(PART) --output $(OUT)

fw-part-write: idf ## Write the file IN into partition PART of the board
	$(call need,PART,a partition name such as models_0)
	$(call need,IN,the file to write from)
	$(parttool) write_partition --partition-name $(PART) --input $(IN)

fw-part-erase: idf ## Erase partition PART of the board
	$(call need,PART,a partition name such as models_0)
	$(parttool) erase_partition --partition-name $(PART)

fw-app: idf ## Build a test app (APP=firmware/test_apps/soak or a components/*/test_apps/*)
	$(call need,APP,the folder of an IDF test app)
	cd $(APP) && idf.py reconfigure && ninja -C build -j$(JOBS)

fw-app-flash: idf ## Flash a built test app, then the monitor (APP= as for fw-app, MONITOR= skips it)
	$(call need,APP,the folder of an IDF test app)
	cd $(APP) && ninja -C build -j$(JOBS) && idf.py $(PORT_FLAG) flash $(MONITOR)

##@ Board on WSL (usbipd)
usb-list: ## USB devices on Windows; the ESP32-S3 shows as 303a:1001
	$(USBIPD) list

usb-attach: ## Attach BUSID=<id> to WSL; the busid follows the USB port, read usb-list
	$(call need,BUSID,make usb-list shows it)
	$(USBIPD) attach --wsl --busid $(BUSID)
	@for i in 1 2 3 4 5; do ls /dev/ttyACM* >/dev/null 2>&1 && break; sleep 1; done; ls -l /dev/ttyACM*

usb-detach: ## Hand BUSID=<id> back to Windows
	$(call need,BUSID,make usb-list shows it)
	$(USBIPD) detach --busid $(BUSID)

##@ Backend and frontend
be-dev: ## NestJS in watch mode
	cd backend && npm run start:dev

be-build: ## Build the API into backend/dist
	cd backend && npm run build

be-prisma: ## Regenerate the Prisma client from backend/prisma/schema.prisma (touches no database)
	cd backend && npm run prisma:generate

be-migrate: ## Create and apply a Prisma migration on the dev database
	cd backend && npm run prisma:migrate

be-seed: ## Seed the database backend/.env names
	cd backend && npm run prisma:seed

be-demo: ## WIPE the database backend/.env names, then load a 5,000-person demo company
	cd backend && npm run prisma:demo

fe-dev: ## Next.js dev server
	cd frontend && npm run dev

fe-build: ## Production build of the dashboard
	cd frontend && npm run build

##@ Docker
up: ## Bring the deploy/ stack up
	cd deploy && docker compose up -d

down: ## Tear the deploy/ stack down
	cd deploy && docker compose down

ml-docker: ## Build the training image facepipe:dev
	cd ml && docker build -t facepipe:dev .

##@ Housekeeping
ml-clean: ## Drop ml/ caches; artifacts and data stay
	cd ml && rm -rf .pytest_cache .ruff_cache .coverage
	cd ml && find src tests -name __pycache__ -type d -prune -exec rm -rf {} +
