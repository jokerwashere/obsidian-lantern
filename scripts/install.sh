#!/bin/bash
# Quick install/update script for the Lantern plugin

set -e

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")/.."

# Default vault location - change this or pass as argument
VAULT="${1:-$HOME/Documents/Obsidian}"

PLUGIN_DIR="$VAULT/.obsidian/plugins/lantern"

# Check if vault exists
if [ ! -d "$VAULT/.obsidian" ]; then
    echo "Error: Obsidian vault not found at $VAULT"
    echo "Usage: ./install.sh /path/to/your/vault"
    exit 1
fi

# Check if this is an update or fresh install
if [ -d "$PLUGIN_DIR" ]; then
    ACTION="Updating"
else
    ACTION="Installing"
fi

# Build if main.js doesn't exist or any source file is newer
# (main.js is gitignored, so a fresh checkout always needs a build)
NEEDS_BUILD=false
if [ ! -f "main.js" ]; then
    NEEDS_BUILD=true
elif [ -n "$(find src -name '*.ts' -newer main.js 2>/dev/null)" ]; then
    NEEDS_BUILD=true
fi

if [ "$NEEDS_BUILD" = true ]; then
    # tsc/esbuild are local devDependencies — install them first if missing
    # (otherwise npm falls back to the system PATH: "tsc: command not found").
    if [ ! -d "node_modules" ]; then
        echo "Installing dependencies (node_modules missing)..."
        npm install --no-audit --no-fund
    fi
    echo "Building plugin..."
    npm run build
fi

# Create plugin directory
mkdir -p "$PLUGIN_DIR"

# Copy files (the plugin is a thin qmd client — no model/WASM files needed)
cp main.js manifest.json styles.css "$PLUGIN_DIR/"

echo "$ACTION complete: $PLUGIN_DIR"
if [ "$ACTION" = "Installing" ]; then
    echo "Restart Obsidian and enable 'Lantern' in Community Plugins"
else
    echo "Reload Obsidian to apply changes"
fi
