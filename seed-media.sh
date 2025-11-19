#!/bin/bash

# Script to seed filelist.txt and config.json from a directory path
# Usage: ./seed-media.sh /path/to/media/files

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if path argument is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: No path provided${NC}"
    echo "Usage: $0 /path/to/media/files"
    exit 1
fi

MEDIA_PATH="$1"

# Check if path exists
if [ ! -d "$MEDIA_PATH" ]; then
    echo -e "${RED}Error: Path does not exist: $MEDIA_PATH${NC}"
    exit 1
fi

# Get absolute path
MEDIA_PATH=$(cd "$MEDIA_PATH" && pwd)

echo -e "${GREEN}Scanning directory (recursively): $MEDIA_PATH${NC}"

# Supported file extensions (lowercase)
VIDEO_EXT="mp4|avi|mov|mkv|webm|flv|wmv|m4v|3gp|ogv"
IMAGE_EXT="jpg|jpeg|png|gif|bmp|webp|svg|tiff|tif|ico"
PDF_EXT="pdf"

# Combine all extensions
ALL_EXT="$VIDEO_EXT|$IMAGE_EXT|$PDF_EXT"

# Temporary file for storing found files
TEMP_FILE=$(mktemp)

# Count files found
FILE_COUNT=0

# Find all supported files recursively
# Using find with -type f to only get files, not directories
# Excluding macOS-specific files: ._* (resource forks) and .DS_Store
# Using case-insensitive name matching with multiple -iname patterns
echo -e "${BLUE}Searching for files (excluding macOS system files)...${NC}"

# Use find with multiple -iname patterns for better compatibility
# Exclude ._* files and .DS_Store files
find "$MEDIA_PATH" -type f \( \
    -iname "*.mp4" -o -iname "*.avi" -o -iname "*.mov" -o -iname "*.mkv" -o \
    -iname "*.webm" -o -iname "*.flv" -o -iname "*.wmv" -o -iname "*.m4v" -o \
    -iname "*.3gp" -o -iname "*.ogv" -o \
    -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" -o -iname "*.gif" -o \
    -iname "*.bmp" -o -iname "*.webp" -o -iname "*.svg" -o -iname "*.tiff" -o \
    -iname "*.tif" -o -iname "*.ico" -o \
    -iname "*.pdf" \
\) ! -name "._*" ! -name ".DS_Store" | while read -r file; do
    # Get relative path from MEDIA_PATH
    rel_path="${file#$MEDIA_PATH/}"
    # Skip if the relative path starts with ._ or is .DS_Store
    if [[ "$(basename "$rel_path")" != .DS_Store ]] && [[ "$(basename "$rel_path")" != ._* ]]; then
        echo "$rel_path"
        FILE_COUNT=$((FILE_COUNT + 1))
    fi
done | sort > "$TEMP_FILE"

# Count files found (re-read from temp file since FILE_COUNT in subshell doesn't persist)
FILE_COUNT=$(wc -l < "$TEMP_FILE" | tr -d ' ')

if [ "$FILE_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}Warning: No supported files found in $MEDIA_PATH${NC}"
    echo "Supported extensions:"
    echo "  Videos: $VIDEO_EXT"
    echo "  Images: $IMAGE_EXT"
    echo "  PDFs: $PDF_EXT"
    echo ""
    echo -e "${BLUE}Debug: Checking if directory has any files...${NC}"
    TEST_COUNT=$(find "$MEDIA_PATH" -type f ! -name "._*" ! -name ".DS_Store" | wc -l | tr -d ' ')
    echo "  Total files in directory (excluding system files): $TEST_COUNT"
    if [ "$TEST_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}  Sample files found:${NC}"
        find "$MEDIA_PATH" -type f ! -name "._*" ! -name ".DS_Store" | head -5 | while read -r f; do
            echo "    - $(basename "$f")"
        done
    fi
    rm "$TEMP_FILE"
    exit 1
fi

echo -e "${GREEN}Found $FILE_COUNT files${NC}"

# Write to filelist.txt
OUTPUT_FILE="filelist.txt"
cp "$TEMP_FILE" "$OUTPUT_FILE"
rm "$TEMP_FILE"

echo -e "${GREEN}Created $OUTPUT_FILE with $FILE_COUNT files${NC}"

# Create or update config.json
CONFIG_FILE="config.json"
CONFIG_EXAMPLE="config.example.json"

# Check if config.json exists
if [ -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}Updating existing $CONFIG_FILE${NC}"
    # Use jq if available, otherwise use sed/awk
    if command -v jq &> /dev/null; then
        jq ".videoBasePath = \"$MEDIA_PATH\"" "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    else
        # Fallback: use sed to update the path
        # This is a simple approach - assumes the JSON structure
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS uses different sed syntax
            sed -i '' "s|\"videoBasePath\": \".*\"|\"videoBasePath\": \"$MEDIA_PATH\"|" "$CONFIG_FILE"
        else
            # Linux sed
            sed -i "s|\"videoBasePath\": \".*\"|\"videoBasePath\": \"$MEDIA_PATH\"|" "$CONFIG_FILE"
        fi
    fi
else
    echo -e "${GREEN}Creating $CONFIG_FILE${NC}"
    # Check if example exists
    if [ -f "$CONFIG_EXAMPLE" ]; then
        cp "$CONFIG_EXAMPLE" "$CONFIG_FILE"
        # Update the path
        if command -v jq &> /dev/null; then
            jq ".videoBasePath = \"$MEDIA_PATH\"" "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
        else
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|\"videoBasePath\": \".*\"|\"videoBasePath\": \"$MEDIA_PATH\"|" "$CONFIG_FILE"
            else
                sed -i "s|\"videoBasePath\": \".*\"|\"videoBasePath\": \"$MEDIA_PATH\"|" "$CONFIG_FILE"
            fi
        fi
    else
        # Create from scratch
        cat > "$CONFIG_FILE" << EOF
{
  "systemName": "HomeTube",
  "videoBasePath": "$MEDIA_PATH"
}
EOF
    fi
fi

echo -e "${GREEN}✓ Configuration updated${NC}"
echo ""
echo -e "${GREEN}Summary:${NC}"
echo "  - $OUTPUT_FILE: $FILE_COUNT files"
echo "  - $CONFIG_FILE: videoBasePath = $MEDIA_PATH"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Review $OUTPUT_FILE to ensure all files are correct"
echo "  2. Create credentials.txt with username:password pairs"
echo "  3. Run: npm start"
