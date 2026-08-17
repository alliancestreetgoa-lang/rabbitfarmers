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

# A failure that has a log already written for it. Print the thing rather than
# the path to the thing: "see .localhost-api.log" makes somebody run a second
# command to find out what happened, and the answer is almost always on the
# last line.
die_log() {
  printf '%s  ✗ %s%s\n' "$red" "$1" "$reset"
  if [ -s "$2" ]; then
    printf '\n%s  last lines of %s:%s\n' "$dim" "$(basename "$2")" "$reset"
    sed 's/^/     /' "$2" | tail -20
  else
    printf '%s     (%s is empty — it did not get far enough to say why)%s\n' \
      "$dim" "$(basename "$2")" "$reset"
  fi
  exit 1
}

# Is somebody already on this port? The commonest way this script fails on a
# laptop, and the least obvious: another server answers the health check with a
# 404 and the only symptom is "the API did not come up".
port_taken() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    # No lsof: settle for "something accepted a connection".
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}

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

# ------------------------------------------------------------ what is here --
#
# Checked up front, by name, because every one of these fails later in a way
# that does not name itself. The Docker path in particular still needs the
# `psql` CLIENT on this machine — the server being in a container does not help
# — and without it the script gets four steps further and then says
# "psql: command not found" from inside a function.
for tool in node npm psql; do
  command -v "$tool" >/dev/null 2>&1 && continue
  case "$tool" in
    node|npm) die "$tool is not installed. Node 22 or newer: https://nodejs.org
     macOS: brew install node" ;;
    psql) die "the psql client is not installed. It is needed even when the
     database itself runs in Docker.
     macOS: brew install libpq && brew link --force libpq
     Debian/Ubuntu: sudo apt install postgresql-client" ;;
  esac
done

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

# ----------------------------------------------------------------- reachable --
#
# Both roles, before anything depends on either. The API opens two pools — the
# farmer-facing one as a role WITHOUT bypassrls, the admin one with it — and
# only the admin one has been exercised by the time we get here, by the
# migrations. So an app_login that cannot connect stays invisible until the
# health check fails, and it fails as "the API did not come up", because
# /health answers 503 when its pool is dead and `curl -f` treats that as no
# server at all. A perfectly running API, reported as missing.
check_role() {
  local url=$1 who=$2 err
  err=$(psql "$url" -qtc 'SELECT 1' 2>&1 >/dev/null) && return 0
  die "the ${who} database role cannot connect.

     ${err}

     Both roles are created by this script and used by the API. If the error is
     about authentication, your pg_hba.conf wants a different method than the
     password these were made with; the quickest way out is to point the script
     at connections you know work:

       DATABASE_URL=... ADMIN_DATABASE_URL=... ./scripts/localhost.sh"
}
check_role "$ADMIN_DATABASE_URL" "admin"
check_role "$DATABASE_URL" "farmer-facing (app_login)"

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

# Said before starting rather than after failing. A laptop has a lot of things
# on :3000, and every one of them makes the health check below fail in a way
# that looks like this project's fault.
for taken in "$API_PORT:API_PORT" "$SITE_PORT:PORT"; do
  p=${taken%%:*}; var=${taken##*:}
  port_taken "$p" && die "port ${p} is already in use by something else.
     Stop it, or run with a different one:  ${var}=$((p + 5)) ./scripts/localhost.sh"
done

# PORT, not API_PORT: that is the name the server reads. Passing it per-command
# rather than exporting it, because the site below reads the same variable and
# they are two different ports — export it once and whichever starts second
# wins.
(cd "$API_DIR" && PORT="$API_PORT" node src/server.js > "$ROOT/.localhost-api.log" 2>&1) &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
  # What it actually said, if it said anything. `curl -f` fails on a 503 the
  # same way it fails on a closed port, and those are completely different
  # problems: one is a server that never started, the other is a server that
  # started and cannot reach its database.
  BODY=$(curl -sS -m 5 -w ' [HTTP %{http_code}]' "http://localhost:${API_PORT}/health" 2>&1)
  [ -n "$BODY" ] && info "GET /health said: ${BODY}"
  die_log "the API did not come up." "$ROOT/.localhost-api.log"
fi
ok "API on :${API_PORT}"

# API_ORIGIN too, or the site proxies to :3000 whatever API_PORT says — and the
# app loads, looks right, and fails every request against whatever else happens
# to be on that port. Worse than not starting.
PORT="$SITE_PORT" API_ORIGIN="http://localhost:${API_PORT}" \
  node "$ROOT/scripts/dev-site.mjs" > "$ROOT/.localhost-site.log" 2>&1 &
SITE_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://localhost:${SITE_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://localhost:${SITE_PORT}/" >/dev/null 2>&1 \
  || die_log "the site did not come up." "$ROOT/.localhost-site.log"
ok "site on :${SITE_PORT}"

# -------------------------------------------------------------- demo farm --
FARMS=$(adminsql -tAc "SELECT count(*) FROM farm" 2>/dev/null || echo 0)
DEMO_LINE=""
if [ "$DEMO" = 1 ] && [ "${FARMS:-0}" = "0" ]; then
  step "A farm with something in it"
  DEMO_OUT=$(API_URL="http://localhost:${API_PORT}" node "$ROOT/scripts/demo-data.mjs" 2>&1)
  if [ $? -eq 0 ]; then
    echo "$DEMO_OUT" | grep -E '^(farm|animals|breeding|health|today|pregnant|ready)' | sed 's/^/    /'
    # The stamp in the seeded address is base-36, so it usually holds a digit.
    # A class without digits still matched, just not the whole address: the
    # empty string when the digit came last, a truncated one when it did not.
    # Either way the banner printed it as the login. Only an all-letter stamp,
    # about one run in five, came out right.
    DEMO_LINE=$(echo "$DEMO_OUT" | grep -oE '[a-z0-9._%+-]+@example\.farm' | head -1)
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
  the money screen     http://localhost:${SITE_PORT}/admin/billing

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
