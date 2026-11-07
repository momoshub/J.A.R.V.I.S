# Restarting without downtime

How the bot restarts into new code, and where that is going. `ARCHITECTURE.md`
describes what runs today; this file is the plan.

## Problem

A self-update used to wait until no turn was running in ANY thread, then exit
and let launchd start the new build. Two things went wrong:

- with several busy threads the bot might never be idle, because new turns kept
  starting while it waited, so the restart could hang forever
- every thread paid for the slowest one: a 20 minute review in one thread held
  back the new version for everyone

## Phase 1 - drain, with a bound (built)

As soon as a restart is asked for, the bot stops taking new work and waits only
for the turns already running.

- the inbox receiver stops claiming rows (`pauseIntake`). The gateway keeps
  writing them, so nothing is lost and the next process handles them
- timers that start turns hold: watcher, inner child, review inbox. Reminders
  still post, since they start no turn
- a workflow step that comes due is left on its row (`continue_as`) and
  `resumeContinues` starts it in the next process
- past `RESTART_MAX_WAIT_MS` (15 min) it exits anyway. Just before, `markCut`
  stamps `cut_at` on every running inbox row. Recovery redelivers a cut row at
  once and ages it from the cut, so a turn that had run for forty minutes is
  picked up again instead of being dropped as stale. The retry gets
  `interruptedRules` and resumes the same session, so it continues rather than
  starts over

Known limits:

- new messages wait until the restart, up to 15 minutes. That is a delay, not
  zero downtime
- turns that are not inbox rows (a watch firing, an inner child fix, a workflow
  step already running) die on a forced exit and are not resumed. launchd kills
  the job's whole process group, so their CLI processes do not linger

## Phase 2 - turns that outlive the bot (next)

The goal is a restart that takes seconds whatever is running.

A turn is already a separate `claude` process. Today its output is read through
a pipe, so the turn dies with the bot. Phase 2 detaches it:

- spawn the CLI in its own process group, and outside launchd's kill
  (`AbandonProcessGroup` in the plist, or a detached spawn), writing its
  stream-json to a file per turn under `data/turns/`
- a `turns` table records each one: pid and start time, thread, session id,
  inbox row, the Slack stream ts it writes to, and the offset read so far
- the bot reads the file instead of the pipe. On restart the new process finds
  live turns in the table (pid + start time, so a reused pid is not mistaken for
  one) and carries on reading each file from its offset, streaming into the
  same Slack message
- a turn that finished while no bot was running is read to the end and settled
  like any other: reply posted, row finished, usage recorded
- the restart no longer waits for anything except in-flight envelopes that are
  not turns (a button ack), which take milliseconds

Things to settle while building it:

- stopping a turn must kill the detached tree, by pid, since the bot that
  started it may be gone (`killTree` already works by pid)
- the per-turn command ticket lives in memory today, so a turn that outlives
  the bot loses it. Tickets move to the database, with the same TTL and use
  budget
- the run registry and thread queue are rebuilt at boot from the `turns` table,
  so the stop button, busy notices and one-turn-per-thread keep working across
  a restart
- workflow steps and watch-fired turns become rows in `turns` like any other,
  which removes the phase 1 limit above

Delivery, each PR shippable alone:

1. tickets in the database
2. the `turns` table and file-backed output, still killed on restart
3. detached spawn plus adoption at boot, and the restart stops waiting

## Not doing

- running two versions of the bot at once (per-thread leases, a gater one
  version behind). An independent review found it needs data moved out of the
  repo, per-sha release folders, a database safe for two writers and fencing
  for sessions before it can work, and phase 2 gets most of the value with a
  single writer
- moving a turn between versions mid-flight: a turn finishes where it started
