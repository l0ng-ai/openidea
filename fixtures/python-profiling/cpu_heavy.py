"""A small CPU-heavy program to profile (Run › Profile).

`fib` is recursive, `primes` calls a generator, and `checksum` spends its time in
built-ins. With `--loop` it keeps working until it is stopped.
"""

import sys


def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)


def primes(limit):
    found = []
    for n in range(2, limit):
        if all(n % p for p in found if p * p <= n):
            found.append(n)
    return found


def checksum(words):
    return sum(sorted(hash(w) % 997 for w in words))


def main():
    fib(22)
    primes(20000)
    checksum(str(i) for i in range(200000))
    print("done", flush=True)
    while "--loop" in sys.argv:
        fib(18)


if __name__ == "__main__":
    main()
