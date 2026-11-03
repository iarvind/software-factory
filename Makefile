.PHONY: deploy dev db typecheck test check launchd-install launchd-uninstall launchd-status logs install-cli

# The shared platform (postgres, db.sh) sits next to this checkout unless PLATFORM_DIR says otherwise.
PLATFORM_DIR ?= $(abspath $(CURDIR)/../dashboard/platform)

deploy: ## build and (re)start the server on :8282 — the one command the dashboard runs
	./ops/deploy.sh

db: ## make sure the shared postgres and the "factory" database are up
	docker compose -f $(PLATFORM_DIR)/compose.yml up -d --wait postgres
	$(PLATFORM_DIR)/db.sh ensure

dev: ## API on :8282 with reload + Vite on :5282 (stop the launchd unit first: make launchd-uninstall)
	npm run dev

typecheck:
	npm run typecheck

test:
	npm test

check: typecheck test

launchd-install: ## keep the server running across logins and crashes
	./ops/launchd.sh install

launchd-uninstall:
	./ops/launchd.sh uninstall

launchd-status:
	./ops/launchd.sh status

logs:
	tail -f data/logs/web.log

install-cli: ## put `factory` on the PATH (~/.local/bin) — set FACTORY_URL and FACTORY_TOKEN in your shell
	mkdir -p $(HOME)/.local/bin
	ln -sf $(CURDIR)/cli/factory.ts $(HOME)/.local/bin/factory
	@echo "installed: $(HOME)/.local/bin/factory (needs node >= 22 on the PATH)"
