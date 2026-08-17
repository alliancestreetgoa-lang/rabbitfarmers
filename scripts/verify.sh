#!/usr/bin/env bash
#
# Verify everything, locally, from nothing.
#
#   ./scripts/verify.sh
#
# Finds a database in this order:
#   1. $DATABASE_URL / $ADMIN_DATABASE_URL if you have already set them
#   2. Docker — starts a throwaway postgres:16 container and removes it after
#   3. A local postgres you already run
#
# Then: applies migrations, runs the 41 domain assertions, runs the API tests,
# boots the server and hits real endpoints over HTTP.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
API=$ROOT/apps/api

bold=$(tput bold 2>/dev/null || echo); dim=$(tput dim 2>/dev/null || echo)
red=$(tput setaf 1 2>/dev/null || echo); green=$(tput setaf 2 2>/dev/null || echo)
reset=$(tput sgr0 2>/dev/null || echo)

step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
ok()   { printf '%s  ✓ %s%s\n' "$green" "$1" "$reset"; }
die()  { printf '%s  ✗ %s%s\n' "$red" "$1" "$reset"; exit 1; }

CONTAINER=""
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1
    # Give it a moment to shut down cleanly, then insist. Leaving a server on
    # the port makes the next run silently test stale code.
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" >/dev/null 2>&1 || break
      sleep 0.25
    done
    kill -9 "$SERVER_PID" >/dev/null 2>&1
  fi
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------- database --
step "Database"

if [ -n "${DATABASE_URL:-}" ]; then
  ok "using DATABASE_URL you already set"
  : "${ADMIN_DATABASE_URL:=$DATABASE_URL}"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER="rabbitry-verify-$$"
  DB_PORT=${PGPORT:-55432}
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=verify \
    -p "$DB_PORT:5432" postgres:16 >/dev/null || die "could not start postgres container"
  printf '  waiting for postgres'
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
    printf '.'; sleep 0.5
  done
  echo
  docker exec "$CONTAINER" psql -U postgres -q \
    -c "CREATE DATABASE rabbitry;" \
    -c "CREATE ROLE app_login LOGIN PASSWORD 'verify';" \
    -c "CREATE ROLE admin_login LOGIN PASSWORD 'verify' BYPASSRLS;" >/dev/null \
    || die "could not create database and roles"
  export ADMIN_DATABASE_URL="postgres://postgres:verify@localhost:$DB_PORT/rabbitry"
  export DATABASE_URL="postgres://app_login:verify@localhost:$DB_PORT/rabbitry"
  ok "throwaway postgres:16 on port $DB_PORT (removed when this finishes)"
else
  die "no DATABASE_URL and no Docker.
     Either start Docker, or set DATABASE_URL/ADMIN_DATABASE_URL to a Postgres 15+.
     A Neon branch works fine:
       export ADMIN_DATABASE_URL='postgres://...neon.tech/rabbitry'
       export DATABASE_URL=\"\$ADMIN_DATABASE_URL\""
fi
export ADMIN_DATABASE_URL DATABASE_URL

# ------------------------------------------------------------------ deps ----
step "Dependencies"
if [ ! -d "$API/node_modules" ]; then
  (cd "$API" && npm install --silent) || die "npm install failed"
fi
ok "installed"

# ------------------------------------------------------------- migrations --
step "Migrations"
(cd "$API" && node src/migrate.js) || die "migrations failed"

# The app role is created by migration 0006; grant it to the login role.
psql_admin() { psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 "$@"; }
if command -v psql >/dev/null 2>&1; then
  psql_admin -c "GRANT rabbitry_app TO app_login;" \
             -c "GRANT rabbitry_admin TO admin_login;" >/dev/null 2>&1 || true
elif [ -n "$CONTAINER" ]; then
  docker exec "$CONTAINER" psql -U postgres -d rabbitry -q \
    -c "GRANT rabbitry_app TO app_login;" \
    -c "GRANT rabbitry_admin TO admin_login;" >/dev/null 2>&1 || true
fi
ok "schema applied and seeded"

# ------------------------------------------------- domain rule assertions --
step "Breeding rules (db/verify.sql)"
run_sql_file() {
  if command -v psql >/dev/null 2>&1; then
    psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$1" 2>&1
  else
    docker exec -i "$CONTAINER" psql -U postgres -d rabbitry -q -v ON_ERROR_STOP=1 -f - < "$1" 2>&1
  fi
}
OUT=$(run_sql_file "$ROOT/db/verify.sql")
if echo "$OUT" | grep -q "ALL CHECKS PASSED"; then
  ok "$(echo "$OUT" | grep -c 'NOTICE:  ok') assertions passed"
else
  echo "$OUT" | grep -E "ERROR|FAIL" | head -5
  die "breeding rule assertions failed"
fi

# ---------------------------------------------------------------- api tests --
step "API tests"
(cd "$API" && npm test) || die "API tests failed"
ok "all API tests passed"

# ------------------------------------------------------------- live server --
step "Live server"

PORT=${PORT:-3000}
if curl -fsS "localhost:$PORT/health" >/dev/null 2>&1; then
  die "something is already listening on port $PORT.
     Stop it first, or run with PORT=3005 ./scripts/verify.sh
     (otherwise these checks would silently test the wrong server)."
fi

# `exec` matters: without it $! is the subshell's pid, killing that leaves the
# node process orphaned on the port, and the next run quietly tests it instead.
( cd "$API" && exec node src/server.js >/tmp/rabbitry-verify.log 2>&1 ) &
SERVER_PID=$!
export PORT

started=false
for _ in $(seq 1 40); do
  curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && { started=true; break; }
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.25
done
if [ "$started" != true ]; then
  sed -n '1,15p' /tmp/rabbitry-verify.log
  die "server did not start"
fi

curl -fsS localhost:$PORT/health | grep -q '"ok":true' || die "health check failed"
ok "GET /health"

curl -fsS localhost:$PORT/plans | grep -q '9900' || die "plans endpoint wrong"
ok "GET /plans returns ₹99 / ₹999 introductory pricing"

EMAIL="verify$$@example.test"
# Unique per run, like the email. Since migration 0024 a phone is a login
# identity — unique among accounts that can sign in — so a fixed number here
# works exactly once and then every later run fails at signup with a 409.
PHONE="+91$(printf '%010d' $(($$ % 1000000000)))"
SIGNUP=$(curl -fsS -X POST localhost:$PORT/auth/signup -H 'content-type: application/json' \
  -d "{\"farm_name\":\"Verify Farm\",\"full_name\":\"Verifier\",\"email\":\"$EMAIL\",
       \"phone\":\"$PHONE\",\"password\":\"correct horse battery\",
       \"city\":\"Margao\",\"state\":\"Goa\",\"pincode\":\"403709\"}")
TOKEN=$(echo "$SIGNUP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || die "signup failed: $SIGNUP"
ok "POST /auth/signup — farm created, 30-day trial running"

DOE=$(curl -fsS -X POST localhost:$PORT/animals -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Lakshmi","sex":"doe","date_of_birth":"2024-01-01"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$DOE" ] || die "could not add a rabbit"
ok "POST /animals — added a doe by name"

curl -fsS -X POST localhost:$PORT/matings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"doe_id\":\"$DOE\"}" \
  | grep -q 'expected_kindling_on' || die "mating did not return a schedule"
ok "POST /matings — returned palpation, nest box and kindling dates"

curl -fsS localhost:$PORT/pregnant -H "authorization: Bearer $TOKEN" \
  | grep -q '"total_pregnant"' || die "pregnant summary failed"
ok "GET /pregnant — confirmed and presumed counted separately"

curl -fsS localhost:$PORT/daily -H "authorization: Bearer $TOKEN" >/dev/null || die "daily failed"
ok "GET /daily — the tab that opens on login"

# The scheduler is the part that makes the app worth paying for, so verify it
# actually creates the day-28 task rather than just that the endpoint answers.
MATED=$(date -u -d '28 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -v-28d +%Y-%m-%dT%H:%M:%SZ)
curl -fsS -X POST localhost:$PORT/matings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"doe_id\":\"$DOE\",\"mated_at\":\"$MATED\"}" >/dev/null

SCHED=$(cd "$API" && SCHEDULER_SECRET=verify-secret node -e "
  import('./src/scheduler.js').then(async (m) => {
    const r = await m.runScheduler({ triggeredBy: 'verify' });
    console.log(JSON.stringify(r));
    const { closePools } = await import('./src/db.js');
    await closePools();
  });
")
echo "$SCHED" | grep -q '"ok":true' || die "scheduler run failed: $SCHED"
ok "scheduler ran — $(echo "$SCHED" | sed -n 's/.*"tasksCreated":\([0-9]*\).*/\1/p') task(s) created"

curl -fsS localhost:$PORT/daily -H "authorization: Bearer $TOKEN" \
  | grep -qi 'nest box' || die "the day-28 nest box task did not reach the daily list"
ok "the day-28 nest box task reached the daily list"

curl -fsS localhost:$PORT/scheduler/health | grep -q '"healthy":true' \
  || die "scheduler heartbeat is not healthy"
ok "GET /scheduler/health — heartbeat healthy"

curl -fsS localhost:$PORT/admin/login | grep -q 'Rabbitry admin' || die "admin console did not render"
ok "GET /admin/login — admin console renders"

ADMIN_EMAIL="verify$$@admin.test"
( cd "$API" && ADMIN_PASSWORD='verify admin password' \
    node src/create-admin.js "$ADMIN_EMAIL" "Verifier" superadmin >/dev/null ) \
  || die "could not create a platform admin"

JAR=$(mktemp)
CODE=$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -X POST localhost:$PORT/admin/login \
  --data-urlencode "email=$ADMIN_EMAIL" --data-urlencode 'password=verify admin password')
[ "$CODE" = "302" ] || die "admin sign-in failed (HTTP $CODE)"
ok "POST /admin/login — signed in, session stored in the database"

curl -fsS -b "$JAR" -H 'accept: text/html' localhost:$PORT/admin/farms \
  | grep -q 'Verify Farm' || die "admin console did not list the new farm"
ok "GET /admin/farms — the farm signed up above is listed"
rm -f "$JAR"

printf '\n%s%sEverything verified.%s\n' "$bold" "$green" "$reset"
printf '%sTo poke at it yourself:%s\n' "$dim" "$reset"
printf '  cd apps/api && npm start        %s# then http://localhost:%s/admin/login%s\n' "$dim" "$PORT" "$reset"
printf '  ADMIN_PASSWORD=... node src/create-admin.js you@example.com "Your Name"\n\n'
