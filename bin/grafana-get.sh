#!/usr/bin/env bash
# Read from the Grafana API, including through a datasource proxy.
#
#   grafana-get.sh '/api/datasources/proxy/uid/<uid>/select/logsql/query?query=*&limit=20'
#
# `gcx api` can POST, PUT and DELETE, so handing it to a sandboxed role would
# hand over write access to Grafana. This wrapper is GET only by construction:
# it refuses a body, a method override, and any path outside the read surface.
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: grafana-get.sh '<api path>'" >&2
  echo "e.g.   grafana-get.sh '/api/datasources/proxy/uid/vlogs/select/logsql/query?query=error&limit=20'" >&2
  exit 2
fi

path=$1

case "$path" in
  /*) ;;
  *) echo "refusing: path must start with /" >&2; exit 2 ;;
esac

# A datasource proxy read, or one of the read-only Grafana endpoints. Anything
# else - folders, dashboards, users, admin - is not this script's business.
case "$path" in
  /api/datasources/proxy/*|/api/datasources|/api/datasources/uid/*|/api/health|/api/search*|/api/dashboards/uid/*) ;;
  *) echo "refusing: $path is not a read path this script serves" >&2; exit 2 ;;
esac

exec gcx api "$path"
