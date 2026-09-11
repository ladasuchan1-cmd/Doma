#!/usr/bin/env python3
"""Vygeneruje náhradní třídu R (jen pro typovou kontrolu Kotlinu mimo Android SDK)."""
import os, re, sys, glob
res = sys.argv[1]; out = sys.argv[2]; pkg = sys.argv[3]
kinds = {'layout': set(), 'id': set(), 'string': set(), 'drawable': set(), 'mipmap': set(), 'array': set(), 'style': set(), 'xml': set(), 'color': set()}
for d in glob.glob(os.path.join(res, '*')):
    name = os.path.basename(d).split('-')[0]
    if name in ('layout', 'drawable', 'mipmap', 'xml'):
        for f in glob.glob(os.path.join(d, '*')):
            kinds[name].add(os.path.splitext(os.path.basename(f))[0])
    for f in glob.glob(os.path.join(d, '*.xml')):
        s = open(f, encoding='utf-8').read()
        for m in re.finditer(r'@\+id/([A-Za-z0-9_]+)', s): kinds['id'].add(m.group(1))
        if name == 'values':
            for m in re.finditer(r'<string name="([A-Za-z0-9_]+)"', s): kinds['string'].add(m.group(1))
            for m in re.finditer(r'<string-array name="([A-Za-z0-9_]+)"', s): kinds['array'].add(m.group(1))
            for m in re.finditer(r'<style name="([A-Za-z0-9_.]+)"', s): kinds['style'].add(m.group(1).replace('.', '_'))
            for m in re.finditer(r'<color name="([A-Za-z0-9_]+)"', s): kinds['color'].add(m.group(1))
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w', encoding='utf-8') as f:
    f.write('package %s;\npublic final class R {\n' % pkg)
    n = 0x7f000000
    for k, names in kinds.items():
        f.write('  public static final class %s {\n' % k)
        for nm in sorted(names):
            n += 1; f.write('    public static final int %s = 0x%x;\n' % (nm, n))
        f.write('  }\n')
    f.write('}\n')
print(out, {k: len(v) for k, v in kinds.items()})
