#!/bin/bash
# Application Watcher - Convenience Wrapper
# Usage: ./watch.sh [options]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
HOST="localhost"
PORT="3000"
WATCHER_DIR=".watcher"
CHECK_INTERVAL="2"
RESPONSE_THRESHOLD="1000"
RUN_CMD=""

# Functions
print_help() {
    cat << EOF
${BLUE}Application Watcher${NC} - Real-time Performance & Error Monitoring

${GREEN}Usage:${NC}
    ./watch.sh [OPTIONS]

${GREEN}Options:${NC}
    -h, --host HOST              Application host (default: localhost)
    -p, --port PORT              Application port (default: 3000)
    -d, --dir DIR                Watcher directory (default: .watcher)
    -i, --interval SECONDS       Check interval (default: 2)
    -t, --threshold MS           Response threshold in ms (default: 1000)
    -r, --run COMMAND            Command to run and wrap (auto-starts app)
    --setup                      Run setup wizard
    --help                       Show this help message

${GREEN}Examples:${NC}
    ./watch.sh                                    # Monitor localhost:3000
    ./watch.sh -p 8080                           # Monitor localhost:8080
    ./watch.sh -h 127.0.0.1 -p 5000 -i 5         # Custom config
    ./watch.sh --setup                           # Initialize watcher

${GREEN}Quick Start:${NC}
    1. Terminal 1: npm start
    2. Terminal 2: ./watch.sh
    3. Use app normally
    4. Press Ctrl+C to stop and generate reports
    5. Check .watcher/reports/ for CSV files

${BLUE}Documentation:${NC}
    See INTEGRATION_GUIDE.md for detailed instructions

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--host)
            HOST="$2"
            shift 2
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        -d|--dir)
            WATCHER_DIR="$2"
            shift 2
            ;;
        -i|--interval)
            CHECK_INTERVAL="$2"
            shift 2
            ;;
        -t|--threshold)
            RESPONSE_THRESHOLD="$2"
            shift 2
            ;;
        -r|--run)
            RUN_CMD="$2"
            shift 2
            ;;
        --setup)
            echo -e "${BLUE}Running setup wizard...${NC}"
            python3 setup_watcher.py
            exit $?
            ;;
        --help)
            print_help
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            print_help
            exit 1
            ;;
    esac
done

# Check Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python3 not found. Please install Python 3.7+${NC}"
    exit 1
fi

# Check if app_watcher.py exists
if [ ! -f "app_watcher.py" ]; then
    if [ ! -f "$WATCHER_DIR/app_watcher.py" ]; then
        echo -e "${RED}❌ app_watcher.py not found${NC}"
        echo -e "${YELLOW}Run: cp app_watcher.py .watcher/${NC}"
        exit 1
    fi
    APP_WATCHER="$WATCHER_DIR/app_watcher.py"
else
    APP_WATCHER="app_watcher.py"
fi

# Check dependencies
echo -e "${BLUE}Checking dependencies...${NC}"
python3 -c "import requests" 2>/dev/null || {
    echo -e "${YELLOW}Installing required packages...${NC}"
    pip3 install -q requests psutil beautifulsoup4
}

# Create watcher directory if needed
mkdir -p "$WATCHER_DIR/logs"
mkdir -p "$WATCHER_DIR/reports"

# Print header
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Application Watcher${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo "  Host:               $HOST"
echo "  Port:               $PORT"
echo "  Check Interval:     ${CHECK_INTERVAL}s"
echo "  Slow Threshold:     ${RESPONSE_THRESHOLD}ms"
echo "  Reports Dir:        $WATCHER_DIR/reports/"
echo ""
echo -e "${GREEN}Status:${NC}"

# Health check
if python3 -c "import requests; requests.get('http://$HOST:$PORT/', timeout=5)" 2>/dev/null; then
    echo -e "  ${GREEN}✅ Application is accessible${NC}"
else
    if [ -z "$RUN_CMD" ]; then
        echo -e "  ${RED}❌ Cannot reach http://$HOST:$PORT/${NC}"
        echo -e "  ${YELLOW}Make sure your application is running first, or use --run to start it.${NC}"
        echo ""
        exit 1
    else
        echo -e "  ${YELLOW}⏳ Application will be started by the watcher...${NC}"
    fi
fi

echo ""
echo -e "${BLUE}Monitoring started...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop and generate reports${NC}"
echo ""

# Prepare RUN argument
RUN_ARG=()
if [ -n "$RUN_CMD" ]; then
    RUN_ARG=(--run "$RUN_CMD")
fi

# Run watcher
python3 "$APP_WATCHER" \
    --host "$HOST" \
    --port "$PORT" \
    --watcher-dir "$WATCHER_DIR" \
    --check-interval "$CHECK_INTERVAL" \
    --response-threshold "$RESPONSE_THRESHOLD" \
    "${RUN_ARG[@]}"

exit_code=$?

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Watcher stopped${NC}"
echo ""
echo -e "${GREEN}Generated reports:${NC}"
ls -lh "$WATCHER_DIR/reports/" 2>/dev/null | tail -5 || echo "  (No reports generated)"
echo ""
echo -e "${GREEN}Next steps:${NC}"
echo "  1. Review reports: $WATCHER_DIR/reports/"
echo "  2. Check error analysis: cat $WATCHER_DIR/reports/error_analysis_*.json"
echo "  3. View logs: tail $WATCHER_DIR/logs/*.log"
echo ""

exit $exit_code
