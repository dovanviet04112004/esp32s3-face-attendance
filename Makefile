.DEFAULT_GOAL := help
SHELL := /bin/bash
.PHONY: help setup ml-sync ml-lock be-install fe-install \
        gen check lint fmt typecheck be-typecheck fe-typecheck test ml-test ml-cov be-test be-e2e \
        data-fetch data-interim data-splits \
        train-det train-spoof train-recog trainctl quantize export golden pack eval-det eval-spoof eval-recog \
        idf fw-secrets fw-dev fw-bench fw-prod fw-fleet fw-size flash monitor fw-log fw-console fw-mac fw-part-read fw-part-write fw-part-erase fw-app fw-app-flash fw-app-test fw-assets fw-fonts \
        release models-release release-status \
        quant-ptq quant-int16 quant-qat quant-variants quant-timing quant-same-int8 quant-choose quant-deploy quant-table \
        ai-probe ai-unit ai-profile speed board-save board-restore \
        usb-list usb-attach usb-detach \
        be-dev be-build be-prisma be-migrate be-seed be-demo be-plans be-backfill fe-dev fe-build fe-remove \
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
# Below 49152: Windows reserves port ranges above it for Hyper-V, anew at every boot.
E2E_PG_PORT ?= 45462
E2E_REDIS_PORT ?= 46392
E2E_MQTT_PORT ?= 41892
E2E_EMQX_PORT ?= 48092
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

fe-remove: ## Remove packages PKG="a b" from frontend/ and from its lockfile
	$(call need,PKG,the package names to remove)
	cd frontend && npm uninstall $(PKG)

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

# Format first: the long lines E501 flags are mostly ones the formatter wraps.
fmt: ## Apply ruff fixes and formatting to ml/
	cd ml && $(ML_PY) -m ruff format . && $(ML_PY) -m ruff check --fix . && $(ML_PY) -m ruff format .

typecheck: be-typecheck fe-typecheck ## tsc over backend/ and frontend/, as CI runs it

be-typecheck: ## tsc over backend/
	cd backend && npm run typecheck

fe-typecheck: ## Route types, then tsc over frontend/
	cd frontend && npm run typecheck

test: ml-test be-test ## Host-side tests of ml/ and backend/

ml-test: ## pytest over ml/ (ARGS= picks tests, such as tests/test_espdl_shapes.py)
	cd ml && $(ML_PY) -m pytest $(ARGS)

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
	  -p $(E2E_PG_PORT):5432 postgres:16-alpine >/dev/null; \
	"$$d" run -d --rm --name ci-e2e-redis -p $(E2E_REDIS_PORT):6379 redis:7-alpine >/dev/null; \
	"$$d" run -d --rm --name ci-e2e-emqx -p $(E2E_MQTT_PORT):1883 -p $(E2E_EMQX_PORT):18083 emqx/emqx:6.3.1 >/dev/null; \
	rm -rf "$$clone"; git clone -q --no-hardlinks "$$repo" "$$clone"; \
	git diff HEAD | (cd "$$clone" && git apply --allow-empty); \
	git ls-files --others --exclude-standard -- backend contracts | while read -r f; do \
	  mkdir -p "$$clone/$$(dirname "$$f")"; cp "$$f" "$$clone/$$f"; done; \
	cd "$$clone/backend"; cp -al "$$repo/backend/node_modules" node_modules; rm -rf node_modules/.prisma; \
	export NODE_ENV=test DATABASE_URL=postgresql://ci:ci@localhost:$(E2E_PG_PORT)/attendance_ci REDIS_URL=redis://localhost:$(E2E_REDIS_PORT) \
	  JWT_ACCESS_SECRET=ci-only-access-secret-0123456789abcdef JWT_REFRESH_SECRET=ci-only-refresh-secret-0123456789abcdef \
	  JWT_DEVICE_SECRET=ci-only-device-secret-0123456789abcdef DEVICE_BOOTSTRAP_TOKEN=ci-only-bootstrap-token \
	  TEMPLATE_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= SEED_ADMIN_PASSWORD=ci-only-admin-password \
	  CORS_ORIGIN=http://localhost:3001 APP_PUBLIC_URL=http://localhost:3001 \
	  MQTT_URL=mqtt://localhost:$(E2E_MQTT_PORT) MQTT_USERNAME=ci MQTT_PASSWORD=ci \
	  EMQX_API_URL=http://localhost:$(E2E_EMQX_PORT)/api/v5 EMQX_API_PASSWORD=public \
	  LOGIN_ATTEMPTS_PER_MINUTE=100000 API_REQUESTS_PER_MINUTE=100000 HEAVY_REQUESTS_PER_MINUTE=100000 \
	  SEARCH_REQUESTS_PER_MINUTE=100000 DEVICE_REGISTER_ATTEMPTS_PER_MINUTE=100000 FORGOT_ATTEMPTS_PER_HOUR=100000 \
	  LOGIN_IP_MISSES=100000 LOGIN_LOCK_AFTER=100 MAIL_HOST=127.0.0.1 MAIL_PORT=2525 MAIL_FROM=no-reply@example.com; \
	for i in $$(seq 60); do "$$d" exec ci-e2e-pg pg_isready -q -U ci && break; sleep 1; done; \
	for i in $$(seq 60); do (echo >/dev/tcp/127.0.0.1/$(E2E_PG_PORT)) 2>/dev/null && (echo >/dev/tcp/127.0.0.1/$(E2E_REDIS_PORT)) 2>/dev/null && break; sleep 1; done; \
	npx prisma generate >/dev/null; npx prisma migrate deploy >/dev/null; npx prisma db seed >/dev/null; \
	rm -rf dist-test; npx tsc -p tsconfig.json --outDir dist-test; \
	for i in $$(seq 60); do curl -s -o /dev/null http://localhost:$(E2E_EMQX_PORT)/ && break; sleep 2; done; \
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

# A defaults file newer than the app's sdkconfig would be ignored for every key the sdkconfig holds.
fw-app: idf ## Build a test app (APP=firmware/test_apps/soak or a components/*/test_apps/*)
	$(call need,APP,the folder of an IDF test app)
	@for f in $(APP)/sdkconfig.defaults* firmware/sdkconfig.defaults.esp32s3 firmware/sdkconfig.{dev,bench}; do \
	  [ $$f -nt $(APP)/sdkconfig ] && rm -f $(APP)/sdkconfig; done; true
	cd $(APP) && idf.py reconfigure && ninja -C build -j$(JOBS)

fw-app-flash: idf ## Flash a built test app, then the monitor (APP= as for fw-app, MONITOR= skips it)
	$(call need,APP,the folder of an IDF test app)
	cd $(APP) && ninja -C build -j$(JOBS) && idf.py $(PORT_FLAG) flash $(MONITOR)

# The options IDF's own pytest.ini adds; a test app outside the IDF tree never reads that file.
fw-app-test: idf ## Flash a built test app and run its pytest_*.py on the board (APP=, PORT=, KEHOACH 4.5.8)
	$(call need,APP,the folder of an IDF test app)
	$(call need,PORT,the board's serial port)
	cd $(APP) && python -m pytest -o python_files='pytest_*.py' --embedded-services esp,idf \
	  --target esp32s3 --port $(PORT) $(ARGS)

fw-assets: idf ## Build the assets partition image into firmware/build/assets.bin (KEHOACH 6.2.8)
	python firmware/assets/build_assets.py $(ARGS)

fw-fonts: ## Rasterise the kiosk UI fonts from MiSans into firmware/assets/fonts
	$(ML_PY) firmware/assets/fonts/gen_font.py $(ARGS)

##@ Release (KEHOACH 7.7: CI publishes the firmware, the models go up from here, kiosks update from the dashboard)

VPS ?= cckiosk
MODELS_IMAGE := firmware/build/models.bin
RELEASE_LOG := $(or $(TMPDIR),/tmp)/release-build.log
fw_version = $(shell sed -n 's/^set(PROJECT_VER "\(.*\)")$$/\1/p' firmware/CMakeLists.txt)
prod_sql = ssh $(VPS) 'docker exec -i kiosk-postgres sh -c "psql -U \"\$$POSTGRES_USER\" -d \"\$$POSTGRES_DB\" -At -v ON_ERROR_STOP=1"'

define MODELS_INFO_PY
import json, struct, sys, zlib
image = open(sys.argv[1], "rb").read()
lock = json.load(open(sys.argv[2]))
if image[:4] != b"MDLS" or zlib.crc32(image[:252]) != struct.unpack_from("<I", image, 252)[0]:
    sys.exit(f"{sys.argv[1]} is no whole models image")
entries = {}
for at in range(min(struct.unpack_from("<I", image, 8)[0], 3)):
    name, _, _, sha, _, _, _ = struct.unpack_from("<16sII32sHHI", image, 16 + 64 * at)
    entries[name.rstrip(b"\0").decode()] = sha.hex()
names = {"detection": "detect", "antispoof": "spoof", "recognition": "recog"}
locked = {names[branch]: lock[branch]["sha256"] for branch in names if branch in lock}
version = "img-%08x" % struct.unpack_from("<I", image, 252)[0]
print(version, "recog-" + entries.get("recog", "?")[:16], "locked" if entries == locked else "stale")
endef
export MODELS_INFO_PY

define UPLOAD_JS
const parts = [];
process.stdin.on("data", (part) => parts.push(part)).on("end", async () => {
  const [target, version, minFw] = process.argv.slice(2);
  const query = new URLSearchParams({ target, version, ...(minFw ? { minFwVersion: minFw } : {}) });
  const answer = await fetch("http://127.0.0.1:" + process.env.PORT + "/releases?" + query, {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.RELEASE_PUBLISH_TOKEN, "content-type": "application/octet-stream" },
    body: Buffer.concat(parts),
  });
  const text = await answer.text();
  if (!answer.ok) {
    console.log("HTTP " + answer.status + " " + text);
    process.exit(1);
  }
  const held = JSON.parse(text);
  const kept = held.release;
  console.log((held.existing ? "already published " : "published ") + kept.version + ", " + kept.sizeBytes + " B, sha256 "
    + kept.sha256 + ", " + (kept.embeddingVersion || "no recog entry") + ", needs firmware " + (kept.minFwVersion || "any"));
});
endef
export UPLOAD_JS

define RELEASE_STATUS_SQL
select 'server   ' || target || ' ' || version || ', published ' || to_char("createdAt", 'YYYY-MM-DD HH24:MI') || ' UTC'
       || coalesce(', ' || "embeddingVersion", '') || coalesce(', needs firmware ' || "minFwVersion", '')
  from (select distinct on (target) * from "Release" where path is not null order by target, "createdAt" desc) newest;
select 'kiosk    ' || id || ', ' || case when online then 'online' else 'offline' end
       || ', fw ' || coalesce("fwVersion", '?') || ', models ' || coalesce("modelVersion", '?')
       || ', ' || coalesce("embeddingVersion", 'recog ?')
       || coalesce(', seen ' || to_char("lastSeenAt", 'YYYY-MM-DD HH24:MI') || ' UTC', '')
  from "Device" where status = 'APPROVED' order by id;
select 'offer    ' || d.id || ', ' || r.target || ' ' || r.version || ' at ' || to_char(d."otaOfferedAt", 'YYYY-MM-DD HH24:MI') || ' UTC, '
       || case when r.version = case when r.target = 'MODELS' then d."modelVersion" else d."fwVersion" end then 'running it'
               when d."bootedAt" > d."otaOfferedAt" then 'restarted without it'
               else 'not taken yet' end
  from "Device" d join "Release" r on r."releaseId" = d."otaReleaseId" where d.status = 'APPROVED' order by d.id;
select 'report   ' || "deviceId" || ', ' || type || ', ' || coalesce(message, '') || ', ' || to_char("receivedAt", 'YYYY-MM-DD HH24:MI') || ' UTC'
  from "DeviceEvent" where type in ('OTA_FAILED', 'OTA_ROLLED_BACK') and "receivedAt" > now() - interval '7 days'
 order by "receivedAt" desc limit 5;
endef
export RELEASE_STATUS_SQL

# Pushing main deploys, so the push waits for a typed y unless YES=1 (KEHOACH 7.7).
release: idf fw-secrets ## Firmware release VER with commit body WHY (both asked when missing): checks, build as CI, commit, push, wait for CI (DRY=1, YES=1)
	@set -euo pipefail; \
	now='$(fw_version)'; ver="$${VER:-}"; why="$${WHY:-}"; \
	command -v gh >/dev/null || { echo "gh is missing: the last step follows the CI run with it"; exit 1; }; \
	[ "$$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "a release goes out from main"; exit 1; }; \
	[ -z "$$(git status --porcelain --untracked-files=no)" ] || { echo "commit or stash first: the release commit holds PROJECT_VER alone"; exit 1; }; \
	git fetch -q origin main; \
	[ "$$(git rev-list --count HEAD..origin/main)" = 0 ] || { echo "main trails origin/main: pull first"; exit 1; }; \
	echo "1/7 main is clean and level with origin, PROJECT_VER is $$now"; \
	git log --oneline origin/main..HEAD | sed 's/^/    also pushes /'; \
	[ -n "$$ver" ] || read -r -p "New version after $$now: " ver || { echo "VER is missing"; exit 1; }; \
	[[ "$$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$$ ]] || { echo "$$ver is not MAJOR.MINOR.PATCH"; exit 1; }; \
	[ "$$ver" != "$$now" ] && [ "$$(printf '%s\n%s\n' "$$now" "$$ver" | sort -V | tail -n1)" = "$$ver" ] \
	  || { echo "$$ver does not come after $$now"; exit 1; }; \
	[ -n "$$why" ] || read -r -p "Why this release (the commit body): " why || { echo "WHY is missing"; exit 1; }; \
	[ -n "$$why" ] || { echo "the commit body cannot be empty"; exit 1; }; \
	echo "2/7 version $$now -> $$ver"; \
	restore() { git checkout -q -- firmware/CMakeLists.txt; }; \
	sed -i "s/^set(PROJECT_VER \".*\")$$/set(PROJECT_VER \"$$ver\")/" firmware/CMakeLists.txt; \
	[ "$$(sed -n 's/^set(PROJECT_VER "\(.*\)")$$/\1/p' firmware/CMakeLists.txt)" = "$$ver" ] || { restore; echo "PROJECT_VER did not take $$ver"; exit 1; }; \
	echo "3/7 building the release image as CI does, log in $(RELEASE_LOG)"; \
	$(MAKE) --no-print-directory fw-fleet > "$(RELEASE_LOG)" 2>&1 || { restore; echo "the build failed, see $(RELEASE_LOG)"; exit 1; }; \
	image=firmware/$(fw_dir_fleet)/face_attendance.bin; \
	built="$$(esptool --chip esp32s3 image-info "$$image" 2>/dev/null | sed -n 's/^App version: *//p')"; \
	[ "$$built" = "$$ver" ] || { restore; echo "the image says $$built, not $$ver"; exit 1; }; \
	grep -qx 'CONFIG_COMPILER_OPTIMIZATION_PERF=y' firmware/$(fw_cfg_fleet) \
	  || { restore; echo "the release image is not -O2, and a -Og image tears the preview (latency.md section 15)"; exit 1; }; \
	echo "4/7 $$image: version $$built, -O2, $$(stat -c %s "$$image") B"; \
	if [ -n "$${DRY:-}" ]; then restore; echo "DRY=1: every check passed, PROJECT_VER stays $$now, nothing committed"; exit 0; fi; \
	git commit -q -m "build(firmware): release $$ver" -m "$$why" -- firmware/CMakeLists.txt; \
	echo "5/7 committed $$(git rev-parse --short HEAD) build(firmware): release $$ver"; \
	if [ -z "$${YES:-}" ]; then \
	  read -r -p "Push main now? It deploys, and CI publishes FIRMWARE $$ver [y/N] " ok || ok=; \
	  [ "$$ok" = y ] || { echo "kept local: git push origin main when ready, then make release-status"; exit 0; }; \
	fi; \
	git push -q origin main; \
	sha=$$(git rev-parse HEAD); run=; \
	for i in $$(seq 30); do \
	  run=$$(gh run list --workflow firmware.yml --commit "$$sha" --json databaseId --jq '.[0].databaseId // empty'); \
	  [ -n "$$run" ] && break; sleep 4; \
	done; \
	[ -n "$$run" ] || { echo "pushed, but no firmware run showed up for $$sha: make release-status later"; exit 1; }; \
	echo "6/7 pushed, following CI run $$run"; \
	gh run watch "$$run" --exit-status --interval 20 || { echo "CI run $$run failed: gh run view $$run --log-failed"; exit 1; }; \
	held=$$(printf "select count(*) from \"Release\" where target = 'FIRMWARE' and version = '%s' and path is not null;\n" "$$ver" | $(prod_sql)); \
	[ "$$held" = 1 ] || { echo "CI passed but the server holds no FIRMWARE $$ver: gh run view $$run --log"; exit 1; }; \
	echo "7/7 the server holds FIRMWARE $$ver"; \
	$(MAKE) --no-print-directory release-status; \
	echo "next: dashboard, Devices page, Update on a kiosk or Update the whole fleet; then make release-status"

# The header carries its packing time, so packing again names a new release: publish the image a desk kiosk ran.
models-release: ## Publish the models image make pack wrote: check it packs the lock, ask on a recognition change, upload on the VPS (MIN_FW=, DRY=1, YES=1)
	@set -euo pipefail; \
	image=$(MODELS_IMAGE); min='$(or $(MIN_FW),$(fw_version))'; \
	[ -f "$$image" ] || { echo "no $$image: make pack PORT=... writes it and runs it on a desk kiosk first"; exit 1; }; \
	read -r version tag packs <<< "$$(python3 -c "$$MODELS_INFO_PY" "$$image" contracts/models.lock.json)"; \
	[ "$$packs" = locked ] || { echo "$$image packs other models than contracts/models.lock.json: make pack PORT=... again"; exit 1; }; \
	echo "1/4 $$image is $$version, $$tag, $$(stat -c %s "$$image") B, packed $$(date -r "$$image" '+%F %R')"; \
	fleet=$$(printf '%s\n' "select id || ' ' || coalesce(\"embeddingVersion\", '?') || ' ' || coalesce(\"modelVersion\", '?') || ' ' || coalesce(\"fwVersion\", '?') from \"Device\" where status = 'APPROVED' order by id;" | $(prod_sql)); \
	fw_held=$$(printf "select count(*) from \"Release\" where target = 'FIRMWARE' and version = '%s' and path is not null;\n" "$$min" | $(prod_sql)); \
	echo "2/4 kiosks need firmware $$min or newer for it; the fleet runs:"; \
	printf '%s\n' "$$fleet" | awk 'NF {print "    " $$1 ": fw " $$4 ", models " $$3 ", " $$2}'; \
	[ "$$fw_held" = 1 ] || echo "    the server holds no FIRMWARE $$min: a kiosk older than it refuses the models until it gets one"; \
	moving=$$(printf '%s\n' "$$fleet" | awk -v tag="$$tag" 'NF && $$2 != tag' | wc -l); \
	if [ "$$moving" -gt 0 ]; then \
	  echo "3/4 !! $$version changes the recognition model of $$moving kiosk(s). Once installed, each drops every face it holds;"; \
	  echo "    everyone captures again once, at any kiosk, and the dashboard installs it only through Update the whole fleet."; \
	  echo "    A kiosk offline at that press keeps the old model and its faces until the next Update the whole fleet."; \
	  if [ -z "$${YES:-}" ]; then read -r -p "Type yes to go on: " ok || ok=; [ "$$ok" = yes ] || { echo "stopped, nothing published"; exit 1; }; fi; \
	else \
	  echo "3/4 same recognition model as the fleet: the faces stay"; \
	fi; \
	if [ -n "$${DRY:-}" ]; then echo "DRY=1: every check passed, nothing published"; exit 0; fi; \
	echo "4/4 uploading $$version on $(VPS)"; \
	code=$$(printf '%s' "$$UPLOAD_JS" | base64 -w0); \
	ssh $(VPS) "docker exec -i kiosk-api node -e 'eval(Buffer.from(process.argv[1], \"base64\").toString())' $$code MODELS $$version $$min" < "$$image"; \
	echo "next: dashboard, Devices page, Update the whole fleet; then make release-status"

release-status: ## Read-only: PROJECT_VER and models.bin here, the firmware CI, the newest releases, each kiosk's versions and OTA reports (VPS=)
	@echo "here     PROJECT_VER $(fw_version), HEAD $$(git rev-parse --short HEAD)"
	@if [ -f $(MODELS_IMAGE) ]; then python3 -c "$$MODELS_INFO_PY" $(MODELS_IMAGE) contracts/models.lock.json \
	  | awk '{print "here     models.bin " $$1 ", " $$2 ", " ($$3 == "locked" ? "packs the lock" : "packs other models than the lock")}'; fi
	@run=$$(gh run list --workflow firmware.yml -L 1 --json databaseId --jq '.[0].databaseId'); \
	gh run view "$$run" --json databaseId,headSha,status,conclusion,jobs \
	  --jq '"ci       firmware run \(.databaseId) on \(.headSha[0:8]): \(.status) \(.conclusion // "")", (.jobs[] | "ci         \(.name): \(.status) \(.conclusion // "")")'
	@printf '%s\n' "$$RELEASE_STATUS_SQL" | $(prod_sql)

##@ ESP-DL ladder and board probe (KEHOACH 3.7; RUN=<run under ml/>, or BRANCH= for the run the lock deploys)

PROBE_APP := firmware/components/ai_engine/test_apps/probe
PROBE_MANIFEST := $(PROBE_APP)/main/probe/manifest.json
PROBE_LOG_S ?= 45
BOARD_PARTS := otadata ota_0 ota_1 models_0 models_1
BOARD_DIR = $(patsubst ~/%,$(HOME)/%,$(DIR))
esptool_board = esptool $(if $(PORT),--port $(PORT)) --chip esp32s3
part_info = $$(python $(IDF_PATH)/components/partition_table/parttool.py -q --partition-table-file $(1) \
  get_partition_info --partition-name $(2) --info $(3))
quant_run = $(or $(RUN),$(if $(BRANCH),artifacts/$(BRANCH)/runs/$(shell python3 -c \
  'import json,sys; print(json.load(open("contracts/models.lock.json"))[sys.argv[1]]["run_id"].split("/", 1)[1])' \
  $(BRANCH))))
need_run = $(if $(quant_run),,$(error RUN or BRANCH is missing: RUN=artifacts/<branch>/runs/<run>, or BRANCH=recognition))
# A ladder step past this dies alone; one without a cap takes the 10 GB WSL VM down with it.
ML_MEM_MAX ?= 7G
ml_capped = systemd-run --user --scope -q -p MemoryMax=$(ML_MEM_MAX) -p MemorySwapMax=0
ladder_step = $(need_run)cd ml && $(ml_capped) $(ML_PY) -m facepipe.compress.quant.ladder $(1) --run $(quant_run)
run_vars = $(if $(RUN),RUN=$(RUN)) $(if $(BRANCH),BRANCH=$(BRANCH))
manifest_field = python3 -c 'import json,sys; v = json.load(open(sys.argv[1]))[sys.argv[2]]; \
  print(" ".join(v) if isinstance(v, list) else v)' $(PROBE_MANIFEST) $(1)

quant-ptq: ## Rungs 1-2: the run's four calibrations, each scored with its branch's ruler beside Q0
	$(call ladder_step,ptq)

quant-int16: ## Rung 3: the most sensitive layers of the best calibration at 16 bits
	$(call ladder_step,int16)

quant-qat: ## Rung 4, which trains: only with ALLOW_TRAIN=1 once the owner says so (STEPS= overrides the config)
	$(call ladder_step,qat) $(if $(ALLOW_TRAIN),--allow-train) $(if $(STEPS),--steps $(STEPS))

quant-variants: ## Each rounding patch of the branch over its best row, scored like any row
	$(call ladder_step,variants)

quant-timing: ## The row make speed times: minmax, no equalization, no bias correction
	$(call ladder_step,timing)

quant-same-int8: ## The run's network code against commit AGAINST (HEAD), integer for integer
	$(call ladder_step,same-int8) --against $(or $(AGAINST),HEAD)

quant-choose: ## KEHOACH 3.7's choice: the best passing row, or a faster one within a step of the ruler
	$(call ladder_step,choose)

quant-deploy: ## Lock ladder row ROW of the run into firmware/models/ and contracts/models.lock.json
	$(call need,ROW,a ladder row such as kl or int16_top4)
	$(call ladder_step,deploy) --row $(ROW)

quant-table: ## The run's ladder, one row a line
	$(call ladder_step,table)

ai-probe: ## The probe of the run's row ROW: its graph, cuts (CUT_RANGE="first last") and real frames
	$(call need,ROW,a ladder row such as timing or kl)
	$(need_run)cd ml && $(ml_capped) $(ML_PY) -m facepipe.compress.quant.probe --run $(quant_run) --row $(ROW) \
	  $(if $(CUT_RANGE),--cut-range $(CUT_RANGE))

# Each image boots the probe app once in front of the monitor, which resets the board as it opens.
ai-unit: idf ai-probe ## Run the probe of ROW on the board: test_apps/probe, then each models image in both slots (PORT=)
	cd $(PROBE_APP) && idf.py reconfigure && ninja -C build -j$(JOBS) && idf.py $(PORT_FLAG) flash
	set -e; logs=($$($(call manifest_field,logs))); i=0; \
	for image in $$($(call manifest_field,images)); do \
	  $(esptool_board) write-flash \
	    $(call part_info,firmware/partitions.dev.csv,models_0,offset) $$image \
	    $(call part_info,firmware/partitions.dev.csv,models_1,offset) $$image < /dev/null; \
	  timeout $(PROBE_LOG_S) script -qfec "cd $(PROBE_APP) && idf.py $(PORT_FLAG) monitor" /dev/null \
	    > $${logs[$$i]} || true; \
	  i=$$((i + 1)); \
	done
	grep -ah "^probe \|^[0-9]* Tests [0-9]* Failures" $$($(call manifest_field,logs))
	for log in $$($(call manifest_field,logs)); do \
	  grep -aq "^[0-9]* Tests 0 Failures" $$log || { echo "$$log: the probe failed or never finished"; exit 1; }; \
	done

ai-profile: ## Rank esp-dl's per-module profile in LOG against the .espdl ESPDL that ran, slow paths tagged (TOP=, ALL=1)
	$(call need,LOG,a board log of make ai-unit)
	$(call need,ESPDL,the .espdl that log ran)
	cd ml && $(ML_PY) -m facepipe.compress.quant.espdl_profile --log $(abspath $(LOG)) \
	  --espdl $(abspath $(ESPDL)) $(if $(TOP),--top $(TOP)) $(if $(ALL),--all)

speed: idf ## KEHOACH 3.7 step 2 for the run: timing row, its probe on the board, the profile ranked
	$(MAKE) --no-print-directory quant-timing $(run_vars)
	$(MAKE) --no-print-directory ai-unit ROW=timing $(run_vars)
	$(MAKE) --no-print-directory ai-profile LOG="$$($(call manifest_field,whole_log))" \
	  ESPDL="$$($(call manifest_field,whole_espdl))"

board-save: idf ## Save bootloader, table, otadata, both app and model slots into DIR; STORAGE=1 adds storage
	$(call need,DIR,a folder outside git, such as ~/esp/backup_boards/<stamp>)
	mkdir -p $(BOARD_DIR)
	$(esptool_board) read-flash 0x8000 0x1000 $(BOARD_DIR)/partition-table.bin
	{ echo "0x0 0x8000 bootloader"; echo "0x8000 0x1000 partition-table"; \
	  for part in $(BOARD_PARTS) $(if $(STORAGE),storage); do \
	    region="$(call part_info,$(BOARD_DIR)/partition-table.bin,$$part,offset size)"; \
	    [ -n "$$region" ] || { echo "the board's table has no $$part" >&2; exit 1; }; \
	    echo "$$region $$part"; \
	  done; } > $(BOARD_DIR)/regions
	while read -r offset size name; do \
	  $(esptool_board) read-flash $$offset $$size $(BOARD_DIR)/$$name.bin < /dev/null; \
	done < $(BOARD_DIR)/regions
	cd $(BOARD_DIR) && sha256sum *.bin > SHA256SUMS && cat regions SHA256SUMS

board-restore: idf ## Write back and verify what board-save kept in DIR; NVS never
	$(call need,DIR,the folder board-save wrote)
	cd $(BOARD_DIR) && sha256sum -c SHA256SUMS
	$(esptool_board) write-flash $$(awk '{print $$1, "$(BOARD_DIR)/" $$3 ".bin"}' $(BOARD_DIR)/regions)
	$(esptool_board) verify-flash $$(awk '{print $$1, "$(BOARD_DIR)/" $$3 ".bin"}' $(BOARD_DIR)/regions)

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

be-schema-sql: ## Print the SQL Prisma writes for schema.prisma against its copy at REF (default HEAD); touches no database
	@set -euo pipefail; from="$$(mktemp --suffix=.prisma)"; trap 'rm -f "$$from"' EXIT; \
	git show "$(or $(REF),HEAD):backend/prisma/schema.prisma" > "$$from"; \
	cd backend && npx prisma migrate diff --from-schema "$$from" --to-schema prisma/schema.prisma --script

be-seed: ## Seed the database backend/.env names
	cd backend && npm run prisma:seed

be-demo: ## WIPE the database backend/.env names, then load a 5,000-person demo company
	cd backend && npm run prisma:demo

be-plans: ## EXPLAIN the reads that touch a big table; fail on an unexcused scan (KEHOACH 9.22.5)
	python3 tools/check_plans.py $(ARGS)

be-backfill: ## Move rows in batches, one transaction each; dry unless ARGS has --apply (KEHOACH 9.22.3)
	python3 tools/backfill.py $(ARGS)

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
