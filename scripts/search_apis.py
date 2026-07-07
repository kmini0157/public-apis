#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Search the public-apis collection from the terminal.

Reads README.md directly (via parse_apis.py), so results are always in
sync with the list - no build step required.

Examples:
    ./apis weather                        # keyword search (name + description)
    ./apis cat --category animals         # restrict to a category
    ./apis --auth no --cors yes music     # only keyless, CORS-enabled APIs
    ./apis --random 3                     # discover something new
    ./apis --list-categories              # show all categories with counts
    ./apis qr code --json                 # machine-readable output
    ./apis --urls jokes                   # URLs only (pipe into xargs, fzf...)

Only the Python standard library is used.
"""

import argparse
import json
import os
import random
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_apis import DEFAULT_README, parse_apis  # noqa: E402

USE_COLOR = sys.stdout.isatty()


def tint(text: str, code: str) -> str:
    return f'\033[{code}m{text}\033[0m' if USE_COLOR else text


def match_query(api: dict, terms) -> bool:
    haystack = f"{api['name']} {api['description']} {api['category']}".lower()
    return all(term in haystack for term in terms)


def match_auth(api: dict, wanted: str) -> bool:
    auth = (api['auth'] or 'no').lower()
    if wanted == 'any':
        return True
    if wanted == 'no':
        return auth == 'no'
    if wanted == 'required':
        return auth != 'no'
    return auth == wanted


def filter_apis(apis, args):
    terms = [t.lower() for t in args.query]
    results = []
    for api in apis:
        if args.category and args.category.lower() not in api['category'].lower():
            continue
        if not match_auth(api, args.auth):
            continue
        if args.https == 'yes' and not api['https']:
            continue
        if args.https == 'no' and api['https']:
            continue
        if args.cors != 'any' and api['cors'] != args.cors:
            continue
        if terms and not match_query(api, terms):
            continue
        results.append(api)
    return results


def print_categories(apis) -> None:
    counts = {}
    for api in apis:
        counts[api['category']] = counts.get(api['category'], 0) + 1
    if not counts:
        print('No categories found.')
        return
    width = max(len(name) for name in counts)
    for name, count in counts.items():
        print(f'{tint(name.ljust(width), "36")}  {count}')
    print(f'\n{len(counts)} categories, {len(apis)} APIs')


def auth_badge(api: dict) -> str:
    if not api['auth']:
        return tint('free', '32')          # green: no key needed
    return tint(api['auth'], '33')         # yellow: key/OAuth required


def print_results(results, total: int) -> None:
    term_width = shutil.get_terminal_size((100, 20)).columns
    current_category = None
    for api in results:
        if api['category'] != current_category:
            current_category = api['category']
            print(f'\n{tint(current_category, "1;35")}')
        flags = [auth_badge(api)]
        if not api['https']:
            flags.append(tint('http-only', '31'))
        if api['cors'] == 'yes':
            flags.append(tint('cors', '36'))
        name = tint(api['name'], '1')
        desc = api['description']
        line = f'  {name}  {desc}'
        # keep one entry per line, truncating long descriptions
        plain_len = 2 + len(api['name']) + 2 + len(desc)
        if plain_len > term_width - 2:
            keep = max(10, term_width - 2 - (2 + len(api['name']) + 2 + 1))
            line = f'  {name}  {desc[:keep]}…'
        print(line)
        print(f'    {tint(api["url"], "4;34")}  [{" | ".join(flags)}]')
    shown = len(results)
    note = f'{shown} / {total} APIs'
    print(f'\n{tint(note, "2")}')


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='apis',
        description='Search the public-apis collection.',
        epilog='Examples:\n'
               '  apis weather --auth no      keyless weather APIs\n'
               '  apis --category anime       everything in one category\n'
               '  apis --random 5             five random picks\n',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('query', nargs='*',
                        help='keywords matched against name, description and category (AND)')
    parser.add_argument('-c', '--category',
                        help='filter by category (substring, case-insensitive)')
    parser.add_argument('--auth', default='any',
                        choices=['any', 'no', 'required', 'apikey', 'oauth'],
                        type=str.lower,
                        help='auth filter: no = keyless, required = needs key/OAuth')
    parser.add_argument('--https', default='any', choices=['any', 'yes', 'no'],
                        type=str.lower, help='HTTPS support filter')
    parser.add_argument('--cors', default='any',
                        choices=['any', 'yes', 'no', 'unknown'],
                        type=str.lower, help='CORS support filter')
    parser.add_argument('--random', type=int, metavar='N', default=0,
                        help='pick N random APIs from the filtered results')
    parser.add_argument('--limit', type=int, metavar='N', default=0,
                        help='show at most N results')
    parser.add_argument('--json', action='store_true',
                        help='output JSON instead of a formatted list')
    parser.add_argument('--urls', action='store_true',
                        help='output matching URLs only, one per line')
    parser.add_argument('--list-categories', action='store_true',
                        help='list all categories with entry counts')
    parser.add_argument('--readme', type=Path, default=DEFAULT_README,
                        help='alternative README.md to search')
    return parser


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)

    if not args.readme.is_file():
        print(f'error: README file not found: {args.readme}', file=sys.stderr)
        return 2
    apis = parse_apis(args.readme)

    if args.list_categories:
        print_categories(apis)
        return 0

    results = filter_apis(apis, args)

    if args.random > 0:
        results = random.sample(results, min(args.random, len(results)))
    if args.limit > 0:
        results = results[:args.limit]

    # exit code 1 on zero matches in every output mode, so scripts can rely on it
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
        return 0 if results else 1
    if args.urls:
        for api in results:
            print(api['url'])
        return 0 if results else 1

    if not results:
        print('No APIs matched. Try fewer keywords, or `--list-categories` '
              'to browse.')
        return 1

    print_results(results, total=len(apis))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BrokenPipeError:
        # the consumer (head, fzf...) closed the pipe early - not an error
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
