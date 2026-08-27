.DEFAULT_GOAL := help
.PHONY: help sync lint fmt test cov clean docker

help:
	@grep -E '^[a-z0-9-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	 awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'

sync: ## Install the locked environment
	uv sync --frozen --all-groups

lint: ## Static checks
	uv run ruff check .
	uv run ruff format --check .

fmt: ## Apply formatting and safe fixes
	uv run ruff check --fix .
	uv run ruff format .

test: ## Run the host-side tests
	uv run pytest

cov: ## Run the tests with a coverage report for core
	uv run pytest --cov=facepipe.core --cov-report=term-missing

docker: ## Build the training image
	docker build -t facepipe:dev .

clean: ## Drop caches, keep artifacts and data
	rm -rf .pytest_cache .ruff_cache .coverage
	find src tests -name __pycache__ -type d -exec rm -rf {} +
