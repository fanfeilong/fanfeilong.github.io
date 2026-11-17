PYTHON ?= python3
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: install
install:
	$(PYTHON) "$(ROOT)scripts/install_skills.py"
