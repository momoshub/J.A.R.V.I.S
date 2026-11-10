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

As soon as a restart is asked for, the bot stops starting work of its own and
waits for the turns already running, while still answering new chat on a
budget.

- new chat messages are still claimed and run, each turn on
  `RESTART_TURN_BUDGET_MS` (2 min by default). One still running past it gets a
  short "hold on" in its thread (once per thread), its turn is stopped and its
  row is stamped `cut_at` and left `running`, so the next process picks it up
  again on the same session. The cut fragment is not stored as an answer, so
  the retry still sees the question as its new turn
- commands (typed with the prefix, or a spoken review request), slash commands
  and buttons are not claimed meanwhile (`waitsForRestart`): they start work
  that cannot be stopped part way, so they wait in the inbox for the next
  process. A held-back command's thread is listed in the drain notice at
  once, not only when the intake closes
- once nothing from before the request is still running or in flight, the
  receiver stops claiming altogether (`pauseIntake`), so the budgeted turns
  left are the last and the wait ends within one budget. The gateway keeps
  writing rows, so nothing is lost and the next process handles them
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

- chat is answered while the turns from before the restart finish, but a
  command, a slash command or a button pressed meanwhile waits until the
  restart, up to 15 minutes. And once the intake closes, everything waits.
  That is a delay, not zero downtime
- a budget cut costs the row one of its `MAX_ATTEMPTS` (4), like any cut: a long
  question caught by several restarts in a row can run out of attempts and be
  dropped with the "cut off on every attempt" notice
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
  so the stop button and one-turn-per-thread keep working across
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
