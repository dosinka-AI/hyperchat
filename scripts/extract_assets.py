#!/usr/bin/env python3
"""Extract embedded PNGs from Scratch SVGs and organize all HyperChat7 assets."""
import base64, os, re, json, shutil, subprocess

SRC = '/home/z/my-project/hyperchat7-ref'
OUT = '/home/z/my-project/hyperchat7-ref/extracted'
os.makedirs(f'{OUT}/images', exist_ok=True)
os.makedirs(f'{OUT}/sounds', exist_ok=True)

with open(f'{SRC}/project.json') as f:
    data = json.load(f)
main = next(t for t in data['targets'] if t['name'] == 'main')
stage = next(t for t in data['targets'] if t['isStage'])

# --- name maps (from project.json costume/sound names) ---
imgs = {}
for c in main['costumes'] + stage['costumes']:
    imgs[c['md5ext'].split('.')[0]] = c['name'] or 'stage-bg'
snds = {}
for s in main['sounds'] + stage['sounds']:
    snds[s['md5ext'].split('.')[0]] = s['name']

def slug(n):
    n = n.lower().strip()
    n = re.sub(r'[^a-z0-9]+', '-', n).strip('-')
    return n

# --- extract images ---
report = []
for md5, name in imgs.items():
    src_svg = f'{SRC}/{md5}.svg'
    src_png = f'{SRC}/{md5}.png'
    dst = f'{OUT}/images/{slug(name)}.png'
    if os.path.exists(src_png):
        shutil.copy(src_png, dst)
        report.append(f'copied png: {name}')
    elif os.path.exists(src_svg):
        svg = open(src_svg, encoding='utf-8', errors='ignore').read()
        m = re.search(r'xlink:href="data:image/(png|jpeg);base64,([^"]+)"', svg)
        if m:
            ext = 'png' if m.group(1) == 'png' else 'jpg'
            dst = f'{OUT}/images/{slug(name)}.{ext}'
            open(dst, 'wb').write(base64.b64decode(m.group(2)))
            report.append(f'extracted {ext}: {name} ({len(m.group(2))//1024}KB b64)')
        else:
            # pure vector svg
            shutil.copy(src_svg, f'{OUT}/images/{slug(name)}.svg')
            report.append(f'copied svg (vector): {name}')
    else:
        report.append(f'MISSING: {name}')

# --- copy sounds ---
for md5, name in snds.items():
    for ext in ('wav', 'ogg'):
        src = f'{SRC}/{md5}.{ext}'
        if os.path.exists(src):
            shutil.copy(src, f'{OUT}/sounds/{slug(name)}.{ext}')
            report.append(f'sound: {name}.{ext}')
            break

print('\n'.join(report))
print('\n=== FINAL FILE LIST ===')
for d in ('images', 'sounds'):
    print(f'--- {d} ---')
    for f in sorted(os.listdir(f'{OUT}/{d}')):
        sz = os.path.getsize(f'{OUT}/{d}/{f}')
        print(f'  {f:48s} {sz//1024:6d} KB')
