"""Tail the transcript while the pipeline is still writing it.

This is the seam where an LLM would plug in: poll for rows newer than the last
id you handled, do something with them, remember the new high-water mark.

    python watch.py                  # follow live
    python watch.py --export         # dump the whole transcript and exit
"""

import argparse
import os
import time

from store import Store

HERE = os.path.dirname(os.path.abspath(__file__))

COLORS = ["\033[36m", "\033[33m", "\033[35m", "\033[32m", "\033[34m", "\033[31m"]
RESET = "\033[0m"


def fmt(row, palette):
    spk = row["speaker"]
    if spk not in palette:
        palette[spk] = COLORS[len(palette) % len(COLORS)]
    m, s = divmod(row["t_start"], 60)
    return f"{palette[spk]}[{int(m):02d}:{s:04.1f}] {spk:<12}{RESET} {row['text']}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=os.path.join(HERE, "transcript.db"))
    p.add_argument("--session", default=None, help="defaults to the most recent")
    p.add_argument("--export", action="store_true", help="print all and exit")
    p.add_argument("--interval", type=float, default=0.5)
    args = p.parse_args()

    store = Store(args.db)
    session = args.session or store.latest_session()
    if not session:
        print("no sessions in this database yet")
        return

    palette, last_id = {}, 0
    if args.export:
        for row in store.since(session, 0):
            print(fmt(row, palette))
        return

    print(f"following session {session} (ctrl-c to stop)\n")
    try:
        while True:
            for row in store.since(session, last_id):
                print(fmt(row, palette), flush=True)  # never buffer a live tail
                last_id = row["id"]
                # <- an LLM consumer would act on `row` right here
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
