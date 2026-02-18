#!/bin/bash
# VibeWorker 启动脚本
# 用法: ./start.sh [start|stop|restart|status]

# 注意：不用 set -e，避免 kill/stop 失败时误退出整个脚本
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
PID_DIR="$SCRIPT_DIR/.pids"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 确保 PID 目录存在
mkdir -p "$PID_DIR"

get_pid() {
    local name=$1
    local pid_file="$PID_DIR/$name.pid"
    if [[ -f "$pid_file" ]]; then
        cat "$pid_file"
    fi
}

is_running() {
    local pid=$1
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    return 1
}

start_backend() {
    local pid=$(get_pid backend)
    if is_running "$pid"; then
        log_warn "后端已在运行 (PID: $pid)"
        return 0
    fi

    log_info "启动后端服务..."
    cd "$BACKEND_DIR"

    # 激活虚拟环境（如果存在）
    if [[ -f "venv/Scripts/activate" ]]; then
        source venv/Scripts/activate
    elif [[ -f "venv/bin/activate" ]]; then
        source venv/bin/activate
    elif [[ -f ".venv/Scripts/activate" ]]; then
        source .venv/Scripts/activate
    elif [[ -f ".venv/bin/activate" ]]; then
        source .venv/bin/activate
    fi

    nohup python app.py > "$PID_DIR/backend.log" 2>&1 &
    local new_pid=$!
    echo $new_pid > "$PID_DIR/backend.pid"

    # 等待启动
    sleep 2
    if is_running "$new_pid"; then
        log_info "后端启动成功 (PID: $new_pid) - http://localhost:8088"
    else
        log_error "后端启动失败，查看日志: $PID_DIR/backend.log"
        return 1
    fi
}

start_frontend() {
    local pid=$(get_pid frontend)
    if is_running "$pid"; then
        log_warn "前端已在运行 (PID: $pid)"
        return 0
    fi

    log_info "启动前端服务..."
    cd "$FRONTEND_DIR"

    nohup npm run dev > "$PID_DIR/frontend.log" 2>&1 &
    local new_pid=$!
    echo $new_pid > "$PID_DIR/frontend.pid"

    # 等待启动
    sleep 3
    if is_running "$new_pid"; then
        log_info "前端启动成功 (PID: $new_pid) - http://localhost:3000"
    else
        log_error "前端启动失败，查看日志: $PID_DIR/frontend.log"
        return 1
    fi
}

stop_process() {
    local name=$1
    local pid=$(get_pid "$name")

    if [[ -z "$pid" ]]; then
        log_warn "$name 未运行"
        return 0
    fi

    if is_running "$pid"; then
        log_info "停止 $name (PID: $pid)..."

        # 尝试优雅终止整个进程组（杀子进程）
        kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true

        # 等待进程结束
        local count=0
        while is_running "$pid" && [[ $count -lt 5 ]]; do
            sleep 1
            ((count++))
        done

        # 如果还在运行，强制终止整个进程组
        if is_running "$pid"; then
            log_warn "强制终止 $name 进程组..."
            kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
            sleep 1
        fi

        if is_running "$pid"; then
            log_error "$name (PID: $pid) 无法终止，将依赖端口清理"
        else
            log_info "$name 已停止"
        fi
    else
        log_warn "$name 进程不存在 (PID: $pid)"
    fi

    rm -f "$PID_DIR/$name.pid"
}

kill_port() {
    local port=$1
    local pids=""

    # 兼容多种环境：优先 lsof，fallback 到 ss+awk 或 fuser
    if command -v lsof &>/dev/null; then
        pids=$(lsof -ti :"$port" 2>/dev/null || true)
    elif command -v ss &>/dev/null; then
        pids=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    elif command -v fuser &>/dev/null; then
        pids=$(fuser "$port"/tcp 2>/dev/null || true)
    fi

    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        log_info "已清理端口 $port 上的残留进程"
    fi
}

wait_port_free() {
    local port=$1
    local retries=0
    while [[ $retries -lt 5 ]]; do
        # 检查端口是否已释放
        if command -v lsof &>/dev/null; then
            lsof -ti :"$port" &>/dev/null || return 0
        elif command -v ss &>/dev/null; then
            ss -tlnp 2>/dev/null | grep -q ":$port " || return 0
        else
            # 没有工具可用，直接返回
            return 0
        fi
        ((retries++))
        log_info "等待端口 $port 释放... ($retries/5)"
        kill_port "$port"
        sleep 1
    done
    log_warn "端口 $port 仍被占用，请手动检查！"
    return 1
}

stop_backend() {
    stop_process "backend"
    # uvicorn reload=True 会 fork 子进程，PID 文件只记录父进程
    # 兜底：杀掉仍占用端口的进程
    kill_port 8088
    wait_port_free 8088
}

stop_frontend() {
    stop_process "frontend"
    # Next.js 可能有子进程，尝试清理
    kill_port 3000
    wait_port_free 3000
}

show_status() {
    echo ""
    echo "========== VibeWorker 状态 =========="

    local backend_pid=$(get_pid backend)
    if is_running "$backend_pid"; then
        echo -e "后端: ${GREEN}运行中${NC} (PID: $backend_pid) - http://localhost:8088"
    else
        echo -e "后端: ${RED}未运行${NC}"
    fi

    local frontend_pid=$(get_pid frontend)
    if is_running "$frontend_pid"; then
        echo -e "前端: ${GREEN}运行中${NC} (PID: $frontend_pid) - http://localhost:3000"
    else
        echo -e "前端: ${RED}未运行${NC}"
    fi

    echo "====================================="
    echo ""
}

show_logs() {
    local service=$1
    local log_file="$PID_DIR/$service.log"

    if [[ -f "$log_file" ]]; then
        tail -f "$log_file"
    else
        log_error "日志文件不存在: $log_file"
    fi
}

start_all() {
    log_info "启动 VibeWorker..."
    start_backend
    start_frontend
    show_status
}

stop_all() {
    log_info "停止 VibeWorker..."
    stop_frontend
    stop_backend
    show_status
}

restart_all() {
    stop_all
    sleep 2
    start_all
}

# 主命令处理
case "${1:-start}" in
    start)
        start_all
        ;;
    stop)
        stop_all
        ;;
    restart)
        restart_all
        ;;
    status)
        show_status
        ;;
    logs)
        if [[ -z "$2" ]]; then
            log_error "用法: $0 logs [backend|frontend]"
            exit 1
        fi
        show_logs "$2"
        ;;
    backend)
        case "${2:-start}" in
            start) start_backend ;;
            stop) stop_backend ;;
            restart) stop_backend; sleep 1; start_backend ;;
            *) log_error "用法: $0 backend [start|stop|restart]" ;;
        esac
        ;;
    frontend)
        case "${2:-start}" in
            start) start_frontend ;;
            stop) stop_frontend ;;
            restart) stop_frontend; sleep 1; start_frontend ;;
            *) log_error "用法: $0 frontend [start|stop|restart]" ;;
        esac
        ;;
    help|--help|-h)
        echo ""
        echo "VibeWorker 启动脚本"
        echo ""
        echo "用法: $0 [命令] [选项]"
        echo ""
        echo "命令:"
        echo "  start           启动前后端 (默认)"
        echo "  stop            停止前后端"
        echo "  restart         重启前后端"
        echo "  status          查看运行状态"
        echo "  logs <服务>     查看日志 (backend|frontend)"
        echo "  backend <操作>  单独操作后端 (start|stop|restart)"
        echo "  frontend <操作> 单独操作前端 (start|stop|restart)"
        echo "  help            显示帮助信息"
        echo ""
        echo "示例:"
        echo "  $0              启动所有服务"
        echo "  $0 restart      重启所有服务"
        echo "  $0 backend restart  仅重启后端"
        echo "  $0 logs backend     查看后端日志"
        echo ""
        ;;
    *)
        log_error "未知命令: $1"
        echo "使用 '$0 help' 查看帮助"
        exit 1
        ;;
esac
