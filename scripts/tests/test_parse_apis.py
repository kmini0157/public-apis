# -*- coding: utf-8 -*-
"""Tests for scripts/parse_apis.py.

Runs with either pytest or the standard library:
    python3 -m unittest scripts.tests.test_parse_apis
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parse_apis import DEFAULT_README, github_anchor, parse_apis

SAMPLE = """\
# Sample list

## Index
* [Animals](#animals)

| API | Description | Call this API |
|:---|:---|:---|
| [Sponsor](https://example.com/) | Should be ignored (before first category) | x |

### Animals
API | Description | Auth | HTTPS | CORS |
|:---|:---|:---|:---|:---|
| [Cat Facts](https://catfact.ninja/) | Random cat facts | No | Yes | Yes |
| [Cats](https://thecatapi.com/) | Pictures of cats | `apiKey` | Yes | No |
| [Old Zoo](http://oldzoo.example/) | Legacy zoo data | `OAuth` | No | Unknown |
| [Trailing](https://trailing.example/) | Row with a trailing empty cell | No | Yes | No | |
"""


class ParseSampleTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        with tempfile.NamedTemporaryFile(
                'w', suffix='.md', delete=False, encoding='utf-8') as fh:
            fh.write(SAMPLE)
            cls.sample_path = Path(fh.name)
        cls.apis = parse_apis(cls.sample_path)

    @classmethod
    def tearDownClass(cls):
        cls.sample_path.unlink()

    def test_parses_all_entries_and_skips_noise(self):
        names = [api['name'] for api in self.apis]
        self.assertEqual(names, ['Cat Facts', 'Cats', 'Old Zoo', 'Trailing'])

    def test_sponsor_table_before_categories_is_ignored(self):
        self.assertNotIn('Sponsor', [api['name'] for api in self.apis])

    def test_fields_are_normalized(self):
        cat_facts, cats, old_zoo, trailing = self.apis
        self.assertIsNone(cat_facts['auth'])
        self.assertEqual(cats['auth'], 'apiKey')
        self.assertEqual(old_zoo['auth'], 'OAuth')
        self.assertTrue(cat_facts['https'])
        self.assertFalse(old_zoo['https'])
        self.assertEqual(cat_facts['cors'], 'yes')
        self.assertEqual(cats['cors'], 'no')
        self.assertEqual(old_zoo['cors'], 'unknown')
        self.assertEqual(trailing['category'], 'Animals')
        self.assertEqual(cat_facts['url'], 'https://catfact.ninja/')


class ParseRealReadmeTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.apis = parse_apis(DEFAULT_README)

    def test_finds_a_large_number_of_apis(self):
        self.assertGreater(len(self.apis), 1000)

    def test_all_categories_present(self):
        categories = {api['category'] for api in self.apis}
        self.assertGreaterEqual(len(categories), 40)
        self.assertIn('Animals', categories)
        self.assertIn('Weather', categories)

    def test_every_entry_is_well_formed(self):
        for api in self.apis:
            self.assertTrue(api['name'])
            self.assertTrue(api['url'].startswith('http'))
            self.assertTrue(api['description'])
            self.assertIn(api['cors'], ('yes', 'no', 'unknown'))
            self.assertIsInstance(api['https'], bool)


class SearchCliTest(unittest.TestCase):
    """Exit-code and robustness contract of scripts/search_apis.py."""

    CLI = str(Path(__file__).resolve().parent.parent / 'search_apis.py')

    def run_cli(self, *argv, **kwargs):
        import subprocess
        return subprocess.run(
            [sys.executable, self.CLI, *argv],
            capture_output=True, text=True, **kwargs)

    def test_zero_matches_exit_1_in_every_output_mode(self):
        for extra in ([], ['--json'], ['--urls']):
            proc = self.run_cli('zzzz-no-such-api-zzzz', *extra)
            self.assertEqual(proc.returncode, 1, extra)
            self.assertNotIn('Traceback', proc.stderr)

    def test_missing_readme_fails_cleanly(self):
        proc = self.run_cli('--readme', '/nonexistent-readme.md')
        self.assertEqual(proc.returncode, 2)
        self.assertIn('not found', proc.stderr)
        self.assertNotIn('Traceback', proc.stderr)

    def test_list_categories_on_empty_readme_does_not_crash(self):
        with tempfile.NamedTemporaryFile(
                'w', suffix='.md', delete=False, encoding='utf-8') as fh:
            fh.write('# nothing here\n')
        try:
            proc = self.run_cli('--readme', fh.name, '--list-categories')
            self.assertEqual(proc.returncode, 0)
            self.assertNotIn('Traceback', proc.stderr)
        finally:
            Path(fh.name).unlink()

    def test_broken_pipe_is_silent(self):
        import subprocess
        proc = subprocess.run(
            f'{sys.executable} {self.CLI} --urls | head -1',
            shell=True, capture_output=True, text=True)
        self.assertNotIn('BrokenPipeError', proc.stderr)
        self.assertNotIn('Traceback', proc.stderr)


class GithubAnchorTest(unittest.TestCase):

    def test_matches_readme_index_style(self):
        self.assertEqual(github_anchor('Animals'), 'animals')
        self.assertEqual(github_anchor('Art & Design'), 'art--design')
        self.assertEqual(github_anchor('Sports & Fitness'), 'sports--fitness')
        self.assertEqual(github_anchor('Anti-Malware'), 'anti-malware')


if __name__ == '__main__':
    unittest.main()
