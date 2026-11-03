"""Readiness validation tests use only in-memory, synthetic reports."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'deploy'))
from readiness import MAX_SAFE, validate_snapshot


def snapshot():
    return {
        'schemaVersion': 1, 'stale': False, 'generatedAt': '2026-01-01T12:00:00Z',
        'warnings': [], 'metadata': {'ccusageVersion': '20.0.33', 'offline': False,
                                     'pricingMode': 'auto', 'limitations': []},
        'days': [],
    }


def populated():
    value = snapshot()
    tokens = {'inputTokens': 1, 'outputTokens': 2, 'cacheWriteTokens': 3,
              'cacheReadTokens': 4, 'totalTokens': 12, 'costUsd': 0.25}
    model = {**tokens, 'model': 'example', 'missingPricing': False,
             'attribution': 'model', 'otherTokens': 2}
    value['days'] = [{**tokens, 'date': '2024-02-29', 'agent': 'example',
                      'models': [model]}]
    return value


class ReadinessTest(unittest.TestCase):
    def invalid(self, value):
        with self.assertRaises(ValueError) as error:
            validate_snapshot(value)
        self.assertEqual(str(error.exception), 'Invalid readiness snapshot')

    def test_valid_snapshots_and_extra_fields(self):
        self.assertIsNone(validate_snapshot(snapshot()))
        value = populated()
        value['extra'] = {'private': 'ignored'}
        value['generatedAt'] = '2026-01-01T12:00:00.123+05:30'
        del value['days'][0]['models'][0]['otherTokens']
        self.assertIsNone(validate_snapshot(value))

    def test_top_level_required_fields(self):
        self.invalid(None)
        for key in snapshot():
            with self.subTest(missing=key):
                value = snapshot()
                del value[key]
                self.invalid(value)
        for key, bad in [('schemaVersion', True), ('schemaVersion', 1.0),
                         ('stale', 0), ('stale', True), ('warnings', [1]),
                         ('days', {}), ('error', None)]:
            with self.subTest(key=key, bad=bad):
                value = snapshot()
                value[key] = bad
                self.invalid(value)

    def test_metadata(self):
        for key, bad in [('ccusageVersion', 'other'), ('offline', 0),
                         ('pricingMode', 'offline'), ('limitations', [None])]:
            with self.subTest(key=key):
                value = snapshot()
                value['metadata'][key] = bad
                self.invalid(value)
        for key in snapshot()['metadata']:
            value = snapshot()
            del value['metadata'][key]
            self.invalid(value)

    def test_timestamps(self):
        for bad in ('2026-01-01', '2026-01-01T00:00:00',
                    '2026-02-30T00:00:00Z', '2026-01-01T00:00:00+01:60',
                    '2026-01-01 00:00:00Z', 'secret', None):
            with self.subTest(bad=bad):
                value = snapshot()
                value['generatedAt'] = bad
                self.invalid(value)

    def test_days_and_models_required_and_types(self):
        for level in ('day', 'model'):
            original = populated()
            item = original['days'][0]
            if level == 'model':
                item = item['models'][0]
            for key in item:
                if key == 'otherTokens':
                    continue
                with self.subTest(level=level, missing=key):
                    value = copy.deepcopy(original)
                    target = value['days'][0]
                    if level == 'model':
                        target = target['models'][0]
                    del target[key]
                    self.invalid(value)
        for key, bad in [('date', '2023-02-29'), ('date', '0000-01-01'),
                         ('date', '2024-2-29'), ('agent', ''), ('models', {})]:
            value = populated()
            value['days'][0][key] = bad
            self.invalid(value)
        for key, bad in [('model', ''), ('attribution', 'other'),
                         ('missingPricing', 1), ('otherTokens', None)]:
            value = populated()
            value['days'][0]['models'][0][key] = bad
            self.invalid(value)
        value = populated()
        value['days'][0]['models'] = [None]
        self.invalid(value)

    def test_numeric_values_and_accounting(self):
        for level in ('day', 'model'):
            for key in ('inputTokens', 'outputTokens', 'cacheWriteTokens',
                        'cacheReadTokens', 'totalTokens', 'costUsd'):
                for bad in (True, -1, float('nan'), float('inf'), '1'):
                    with self.subTest(level=level, key=key, bad=bad):
                        value = populated()
                        target = value['days'][0]
                        if level == 'model':
                            target = target['models'][0]
                        target[key] = bad
                        self.invalid(value)
            for bad in (1.5, MAX_SAFE + 1):
                value = populated()
                target = value['days'][0]
                if level == 'model':
                    target = target['models'][0]
                target['inputTokens'] = bad
                self.invalid(value)
        value = populated()
        value['days'][0]['models'][0]['otherTokens'] = 1
        self.invalid(value)
        value = populated()
        value['days'][0]['totalTokens'] = MAX_SAFE
        value['days'].append(copy.deepcopy(value['days'][0]))
        self.invalid(value)


if __name__ == '__main__':
    unittest.main()
