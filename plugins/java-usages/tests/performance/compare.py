"""Compare full normalized results separately from uninstrumented latency samples."""
import collections
import hashlib
import json
import pathlib
import statistics
import sys
root = pathlib.Path(sys.argv[1])

def read(name):
    return json.loads((root / name).read_text())

def canonical(run, result):
    rows = result['rows'] if isinstance(result, dict) else result
    return sorted(json.dumps({k:v for k,v in r.items() if k != "access"}, sort_keys=True).replace(run['workspace'], '<workspace>') for r in rows)

base = read('count-baseline.json')
checks = []
counts = {}
for variant in ['optimized', 'fallback']:
    run = read(f'count-{variant}.json')
    for name, result in base['results'].items():
        assert canonical(base, result) == canonical(run, run['results'][name]), (variant, name)
        checks.append(f'{variant}: identical {name}')
    assert not any(d.get('severity') == 1 for m in run['diagnostics'] for d in m['params']['diagnostics'])
for name, result in base['results'].items():
    if isinstance(result, dict):
        counts[name] = {v:read(f'count-{v}.json')['results'][name]['engineSearches'] for v in ['baseline','optimized','fallback']}
        assert result['engineSearches'] == result['handlerSearches']
        counts[name]['rows'] = len(result['rows'])
        counts[name]['kinds'] = dict(collections.Counter(r['kind'] for r in result['rows']))
assert counts['builder']['kinds']['unknown'] == 150
assert counts['plain']['baseline'] == 6 and counts['plain']['optimized'] == 3
assert counts['explicit']['baseline'] == 8 and counts['explicit']['optimized'] == 3
assert counts['fluent']['baseline'] == 4 and counts['fluent']['optimized'] == 3
assert counts['builder']['baseline'] == 7 and counts['builder']['optimized'] == 4

# Access metadata has its own assertions, separate from legacy row equality.
access_checks = {}
optimized = read('count-optimized.json')
fallback = read('count-fallback.json')
for name, result in optimized['results'].items():
    if not isinstance(result, dict): continue
    actual = dict(collections.Counter(r['access'] for r in result['rows']))
    access_checks[name] = actual
    normal = lambda run, rows: sorted(json.dumps(r, sort_keys=True).replace(run['workspace'], '<workspace>') for r in rows)
    assert normal(optimized, result['rows']) == normal(fallback, fallback['results'][name]['rows']), name
    if name in ['plain', 'explicit', 'fluent']: assert actual == {'read':300, 'write':300}, name
    if name == 'builder': assert actual == {'read':300, 'write':300, 'unknown':150}
    if name in ['method', 'method-accessorsOff']: assert actual == {'unknown':150}, name
    if name.endswith('-accessorsOff') and not name.startswith('method'): assert actual == {'read':150, 'write':150}, name
    if name == 'includeDeclaration': assert actual == {'read':300, 'write':300, 'unknown':1}

def distribution(values):
    values = sorted(values)
    return {'n':len(values), 'median_ms':statistics.median(values), 'p95_ms':values[max(0, __import__('math').ceil(.95*len(values))-1)], 'min_ms':min(values), 'max_ms':max(values), 'samples_ms':values}
latency = {}
for variant in ['baseline','optimized']:
    runs = [read(f'{variant}-{i}.json') for i in range(3)]
    for run in runs:
        for name,result in run['results'].items():
            assert canonical(base, base['results'][name]) == canonical(run, result), (variant,name)
    latency[variant] = {}
    for name in runs[0]['samples']:
        latency[variant][name] = {'first_touch':distribution([r['samples'][name]['first_ms'] for r in runs]), 'warm':distribution([v for r in runs for v in r['samples'][name]['warm_ms']])}
print(json.dumps({'correctnessChecks':checks,'counts':counts,'accessChecks':access_checks,'latency':latency},indent=2))
