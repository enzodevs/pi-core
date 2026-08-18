.DEFAULT_GOAL := help

.PHONY: help install format format-check typecheck test fallow health check pack clean

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install locked development dependencies
	npm ci

format: ## Format and lint with Biome
	npm run format

format-check: ## Check formatting and lint without writing
	npm run format:check

typecheck: ## Run strict TypeScript checks
	npm run typecheck

test: ## Run the Vitest suite
	npm test

fallow: ## Gate on Fallow dead-code findings
	npm run fallow

health: ## Report advisory Fallow health findings
	npm run fallow:health

check: ## Run all required verification
	npm run check

pack: check ## Verify the published package contents
	npm pack --dry-run

clean: ## Remove generated local artifacts
	rm -rf coverage *.tgz .fallow
