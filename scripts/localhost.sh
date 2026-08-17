#!/usr/bin/env bash
#
# Run the whole product on this machine, from nothing.
#
#   ./scripts/localhost.sh
#
# Database, migrations, an admin account, a farm with rabbits in it, the app
# built, and everything served on one port — then it sits there until you press
# Ctrl-C. Safe to run repeatedly: it keeps what is already there and only fills
# in what is missing.
#
#   --fresh     throw the database away and start over
#   --rebuild   rebuild the web app even if dist/ already exists
#   --no-demo   skip the sample farm (an empty farm is a fair test too)
#
# This is deliberately one script rather than the eight commands it replaces.
# Every one of those steps is a place to stop, and the interesting part of this
# project — a doe overdue for palpation, a medicine round, a litter to separate
# — only appears after all of them.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
API_DIR=$ROOT/apps/api
APP_DIR=$ROOT/apps/mobile

bold=$(tput bold 2>/dev/null || echo); dim=$(tput dim 2>/dev/null || echo)
red=$(tput setaf 1 2>/dev/null || echo); green=$(tput setaf 2 2>/dev/null || echo)
reset=$(tput sgr0 2>/dev/null || echo)
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
ok()   { printf '%s  ✓ %s%s\n' "$green" "$1" "$reset"; }
info() { printf '%s    %s%s\n' "$dim" "$1" "$reset"; }
die()  { printf '%s  ✗ %s%s\n' "$red" "$1" "$reset"; exit 1; }

FRESH=0; REBUILD=0; DEMO=1
for arg in "$@"; do
  case "$arg" in
    --fresh)   FRESH=1 ;;
    --rebuild) REBUILD=1 ;;
    --no-demo) DEMO=0 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

API_PORT=${API_PORT:-3000}
SITE_PORT=${PORT:-8080}
DB_NAME=${DB_NAME:-rabbitry}
DB_PASS=${DB_PASS:-localdev}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@rabbitry.local}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-rabbitry-local-admin}
export SCHEDULER_SECRET=${SCHEDULER_SECRET:-local-dev-secret}

CONTAINER=""
API_PID=""; SITE_PID=""
cleanup() {
  [ -n "$API_PID" ]  && kill "$API_PID"  >/dev/null 2>&1
  [ -n "$SITE_PID" ] && kill "$SITE_PID" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- database --
step "Database"

# Order matters: something you have already set wins, then a Postgres already
# running here, then Docker. The last one is a container that KEEPS its data —
# unlike verify.sh's throwaway — because a farm you have to re-enter every
# morning is not a farm you will use.
if [ -n "${DATABASE_URL:-}" ]; then
  ok "using the DATABASE_URL you set"
  : "${ADMIN_DATABASE_URL:=$DATABASE_URL}"
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
  SUPER="postgres://postgres:${DB_PASS}@localhost:5432/postgres"
  psql "$SUPER" -qtc 'SELECT 1' >/dev/null 2>&1 || SUPER="postgres:///postgres"
  psql "$SUPER" -qtc 'SELECT 1' >/dev/null 2>&1 \
    || die "Postgres is running but this script cannot connect as a superuser.
     Set DATABASE_URL and ADMIN_DATABASE_URL yourself and run again."
  ok "using the Postgres already running on :5432"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=rabbitry-local
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      docker start "$CONTAINER" >/dev/null || die "could not start the $CONTAINER container"
      info "restarted the $CONTAINER container, data intact"
    else
      docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$DB_PASS" \
        -p 5432:5432 -v rabbitry-local-data:/var/lib/postgresql/data \
        postgres:16 >/dev/null || die "could not start postgres in Docker"
      info "started postgres:16 in Docker, on a named volume that survives"
    fi
    printf '    waiting for postgres'
    for _ in $(seq 1 60); do
      docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
      printf '.'; sleep 0.5
    done
    echo
  fi
  SUPER="postgres://postgres:${DB_PASS}@localhost:5432/postgres"
  ok "postgres in Docker ($CONTAINER)"
else
  die "no database. Install PostgreSQL 15+, or start Docker, or set DATABASE_URL."
fi

if [ -z "${DATABASE_URL:-}" ]; then
  psqls() { psql "$SUPER" -q -v ON_ERROR_STOP=1 "$@"; }

  if [ "$FRESH" = 1 ]; then
    psqls -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);" >/dev/null 2>&1 \
      || psqls -c "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null 2>&1
    info "dropped ${DB_NAME}"
  fi

  psqls -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1 \
    || psqls -c "CREATE DATABASE ${DB_NAME};" >/dev/null \
    || die "could not create the ${DB_NAME} database"

  # Two login roles, because the whole tenant isolation story depends on the
  # API connecting as one that cannot bypass row-level security.
  psqls -c "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_login') THEN
        CREATE ROLE app_login LOGIN PASSWORD '${DB_PASS}';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='admin_login') THEN
        CREATE ROLE admin_login LOGIN PASSWORD '${DB_PASS}' BYPASSRLS;
      END IF;
    END \$\$;" >/dev/null || die "could not create the login roles"

  export ADMIN_DATABASE_URL="postgres://postgres:${DB_PASS}@localhost:5432/${DB_NAME}"
  export DATABASE_URL="postgres://app_login:${DB_PASS}@localhost:5432/${DB_NAME}"
fi
export ADMIN_DATABASE_URL DATABASE_URL

adminsql() { psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 "$@"; }

# ------------------------------------------------------------ dependencies --
step "Dependencies"
[ -d "$API_DIR/node_modules" ] || (cd "$API_DIR" && npm install --silent) || die "npm install failed in apps/api"
[ -d "$APP_DIR/node_modules" ] || (cd "$APP_DIR" && npm install --silent) || die "npm install failed in apps/mobile"
ok "installed"

# -------------------------------------------------------------- migrations --
step "Migrations"
(cd "$API_DIR" && node src/migrate.js) || die "migrations failed"
# rabbitry_app and rabbitry_admin are created BY the migrations, so the grant
# has to come after them.
adminsql -c "GRANT rabbitry_app TO app_login;" \
         -c "GRANT rabbitry_admin TO admin_login;" >/dev/null 2>&1 || true
ok "schema applied"

# ------------------------------------------------------------------- admin --
step "Admin account"
HAVE_ADMIN=$(adminsql -tAc "SELECT count(*) FROM platform_admin WHERE email='${ADMIN_EMAIL}'" 2>/dev/null || echo 0)
if [ "${HAVE_ADMIN:-0}" = "0" ]; then
  (cd "$API_DIR" && ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    node src/create-admin.js "$ADMIN_EMAIL" "Local Admin" superadmin >/dev/null) \
    || die "could not create the admin"
  ok "created ${ADMIN_EMAIL}"
else
  ok "${ADMIN_EMAIL} already exists"
fi

# --------------------------------------------------------------- the app ----
step "Web app"
if [ "$REBUILD" = 1 ] || [ ! -f "$APP_DIR/dist/index.html" ]; then
  # Empty on purpose: the app then calls /api on whatever origin served it,
  # which is the same thing the Netlify build does. --clear because Metro's
  # transform cache is not keyed on EXPO_PUBLIC_* values.
  (cd "$APP_DIR" && EXPO_PUBLIC_API_URL="" npx expo export --clear --platform web \
    --output-dir dist >/dev/null 2>&1) || die "the web build failed"
  ok "built"
else
  ok "dist/ is there already"
  info "rebuild it after changing the app: ./scripts/localhost.sh --rebuild"
fi

# ------------------------------------------------------------ the API up ----
step "Starting"
(cd "$API_DIR" && node src/server.js > "$ROOT/.localhost-api.log" 2>&1) &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1 \
  || die "the API did not come up. See .localhost-api.log"
ok "API on :${API_PORT}"

PORT="$SITE_PORT" node "$ROOT/scripts/dev-site.mjs" > "$ROOT/.localhost-site.log" 2>&1 &
SITE_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://localhost:${SITE_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://localhost:${SITE_PORT}/" >/dev/null 2>&1 \
  || die "the site did not come up. See .localhost-site.log"
ok "site on :${SITE_PORT}"

# -------------------------------------------------------------- demo farm --
FARMS=$(adminsql -tAc "SELECT count(*) FROM farm" 2>/dev/null || echo 0)
DEMO_LINE=""
if [ "$DEMO" = 1 ] && [ "${FARMS:-0}" = "0" ]; then
  step "A farm with something in it"
  DEMO_OUT=$(API_URL="http://localhost:${API_PORT}" node "$ROOT/scripts/demo-data.mjs" 2>&1)
  if [ $? -eq 0 ]; then
    echo "$DEMO_OUT" | grep -E '^(farm|animals|breeding|health|today|pregnant|ready)' | sed 's/^/    /'
    DEMO_LINE=$(echo "$DEMO_OUT" | grep -o '[a-z.]*@example\.farm' | head -1)
  else
    printf '%s  ! the demo seed failed; the app still works, just empty%s\n' "$red" "$reset"
    echo "$DEMO_OUT" | tail -3 | sed 's/^/    /'
  fi
elif [ "${FARMS:-0}" != "0" ]; then
  step "Farms"
  ok "${FARMS} already here — not seeding over them"
  DEMO_LINE=$(adminsql -tAc "SELECT email FROM employee WHERE role='owner' ORDER BY created_at LIMIT 1" 2>/dev/null | tr -d ' ')
fi

# A pass now, so Today has the nest box and medicine rows in it rather than
# waiting up to fifteen minutes for the first scheduled one.
curl -fsS -X POST "http://localhost:${API_PORT}/scheduler/run" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" >/dev/null 2>&1

# --------------------------------------------------------------- and done --
cat <<EOF

$bold  Rabbitry is running.$reset

  the farmer's app     http://localhost:${SITE_PORT}
  the admin console    http://localhost:${SITE_PORT}/admin/login

  admin                ${ADMIN_EMAIL}
                       ${ADMIN_PASSWORD}
EOF
[ -n "$DEMO_LINE" ] && cat <<EOF
  farmer               ${DEMO_LINE}
                       ${DEMO_PASSWORD:-sunrise-demo-2026}
EOF
cat <<EOF

$dim  One port on purpose: /daily is both a screen and an endpoint, so a
  two-port setup cannot tell you which one a deploy would answer with.
  Logs: .localhost-api.log, .localhost-site.log
  Ctrl-C to stop.$reset

EOF

# Wait on whichever dies first, so a crashed API does not leave a site serving
# a page that cannot talk to anything.
wait -n "$API_PID" "$SITE_PID" 2>/dev/null || wait "$API_PID"
printf '\n%s  one of the servers stopped — see the logs above%s\n' "$red" "$reset"
