#!/bin/sh
# The Custom AI provider's same-origin proxy, off unless OPENFLOWKIT_AI_UPSTREAM is set (an OpenAI-compatible base URL,
# e.g. http://host.docker.internal:11434/v1). It forwards exactly two paths there: GET /ai-proxy/models and
# POST /ai-proxy/chat/completions. The upstream comes from the server's environment, never from the browser, so this is
# not an open proxy. The key passes through in the Authorization header; nothing here logs it (access log off, and nginx
# never logs headers or bodies). Runs from /docker-entrypoint.d before nginx starts.
set -eu
dir="${OFK_NGINX_DIR:-/etc/nginx/ofk}"
mkdir -p "$dir"
out="$dir/ai-proxy.conf"
upstream="${OPENFLOWKIT_AI_UPSTREAM:-}"
upstream="${upstream%/}"

if [ -z "$upstream" ]; then
  cat > "$out" <<'CONF'
location ^~ /ai-proxy/ {
    default_type application/json;
    return 503 '{"error":{"message":"This server has no AI proxy. Start it with OPENFLOWKIT_AI_UPSTREAM set to your OpenAI-compatible endpoint."}}';
}
CONF
  exit 0
fi

case "$upstream" in
  http://?*|https://?*) ;;
  *) echo "OPENFLOWKIT_AI_UPSTREAM must be an http:// or https:// URL, got: $upstream" >&2; exit 1 ;;
esac
# It is written into nginx config: anything that could end a directive or expand a variable is refused.
case "$upstream" in
  *[[:space:]\;\'\"\{\}\$\\]*) echo "OPENFLOWKIT_AI_UPSTREAM has a character nginx config cannot take: $upstream" >&2; exit 1 ;;
esac

common='
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_set_header Host $proxy_host;
    proxy_set_header Connection "";
    proxy_set_header Origin "";
    proxy_set_header Referer "";
    proxy_set_header Cookie "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 25m;
    gzip off;
    access_log off;'

cat > "$out" <<CONF
location = /ai-proxy/models {
    limit_except GET { deny all; }
    proxy_pass $upstream/models;$common
}
location = /ai-proxy/chat/completions {
    limit_except POST { deny all; }
    proxy_pass $upstream/chat/completions;$common
}
location ^~ /ai-proxy/ {
    return 404;
}
CONF
echo "openflowkit: AI proxy on, /ai-proxy/ -> $upstream"
