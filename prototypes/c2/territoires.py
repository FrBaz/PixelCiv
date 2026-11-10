# Prototype de la séance C2 : territoires organiques.
# Reprend les établissements de la seconde version (villages.py), trace des routes entre
# villages d'une même civilisation, puis calcule l'influence de chaque village par coût de
# déplacement depuis ses bâtiments, au lieu d'un cercle.
# Usage : dans le dossier de villages.py, à côté de c1_masks.pkl et c1_apres.png.
# Référence pour la phase 3, pas code de production.
import numpy as np
from scipy import ndimage
from scipy.sparse.csgraph import minimum_spanning_tree
from skimage.graph import MCP_Geometric, route_through_array
from PIL import Image, ImageDraw, ImageFont

ns = {}
exec(open('villages.py', encoding='utf-8').read(), ns)   # rejoue la seconde version (même dossier)
v2, NB, ALT, LAND, BUILDABLE, RIV = ns['v2'], ns['NB'], ns['ALT'], ns['LAND'], ns['BUILDABLE'], ns['RIV']
OCEAN, LAKE, BASE, COLORS, voronoi = ns['OCEAN'], ns['LAKE'], ns['BASE'], ns['COLORS'], ns['voronoi']
NY, NX = ALT.shape; YY, XX = np.mgrid[0:NY, 0:NX]

# --- Coût de déplacement (C1, D11 : relief ; biome) ---------------------------------
BIOME_COST = {
    'grassland': 1.0, 'steppe': 1.0, 'savanna': 1.0, 'tropical_grassland': 1.0, 'cold_steppe': 1.0,
    'beach': 1.0, 'salt_flat': 1.2, 'desert': 1.3, 'tundra': 1.3, 'temperate_forest': 1.5,
    'cold_forest': 1.5, 'taiga': 1.5, 'tropical_forest': 1.5, 'temperate_rainforest': 1.5,
    'rocky_coast': 1.5, 'rainforest': 2.0, 'alpine': 2.0, 'mountain': 2.5, 'marsh': 3.0, 'bog': 3.0,
    'salt_marsh': 3.0, 'swamp': 3.5, 'mangrove': 3.5, 'high_mountain': 4.0, 'cliff': 4.0, 'snow': 5.0,
}
relief = np.select([ALT < 400, ALT < 1000, ALT < 1800, ALT < 2600, ALT < 3800], [1, 1.5, 2.5, 4, 6], default=-1)
COST = np.vectorize(lambda b: BIOME_COST.get(b, 1.5))(NB) * relief
COST = np.where(RIV, COST + 3.0, COST)          # franchir une rivière coûte cher, sauf par un pont
COST = np.where(OCEAN | (LAKE > 0) | (relief < 0), -1.0, COST)   # infranchissable
ROAD_FACTOR = 0.6

# --- Routes : arbre couvrant minimal par civilisation, tracé au moindre coût ----------
ROADS = np.zeros(COST.shape, bool)
for c in sorted({v['civ'] for v in v2}):
    vs = [v for v in v2 if v['civ'] == c]
    if len(vs) < 2:
        continue
    P = np.array([(v['y'], v['x']) for v in vs], float)
    D = np.sqrt(((P[:, None] - P[None]) ** 2).sum(-1))
    mst = minimum_spanning_tree(D).tocoo()
    for i, j, d in zip(mst.row, mst.col, mst.data):
        if d > 60:
            continue
        path, _ = route_through_array(np.where(COST < 0, 1e6, COST), (vs[i]['y'], vs[i]['x']),
                                      (vs[j]['y'], vs[j]['x']), fully_connected=True, geometric=True)
        for y, x in path:
            if COST[y, x] > 0:
                ROADS[y, x] = True
COST_R = np.where(ROADS & (COST > 0), np.where(RIV, COST - 3.0, COST) * ROAD_FACTOR, COST)  # route = pont

# --- Zones bâties (mêmes règles que villages.py) ------------------------------------
dist0, lab0 = voronoi(v2)
def built_cells(i, v):
    b = int(np.ceil(v['pop'] / 15)); rr = int(np.sqrt(b) * 1.6) + 3
    y1, y2, x1, x2 = max(0, v['y'] - rr), min(NY, v['y'] + rr + 1), max(0, v['x'] - rr), min(NX, v['x'] + rr + 1)
    sub = BUILDABLE[y1:y2, x1:x2] & (lab0[y1:y2, x1:x2] == i)
    dd = (YY[y1:y2, x1:x2] - v['y']) ** 2 + (XX[y1:y2, x1:x2] - v['x']) ** 2
    idx = np.argsort(np.where(sub, dd, 1e9), axis=None)[:b]
    yy, xx = np.unravel_index(idx, sub.shape); ok = sub[yy, xx]
    cells = list(zip(y1 + yy[ok], x1 + xx[ok]))
    return cells or [(v['y'], v['x'])]
BUILT = [built_cells(i, v) for i, v in enumerate(v2)]
BUILT_MASK = np.zeros(COST.shape, bool)
for cells in BUILT:
    for y, x in cells:
        BUILT_MASK[y, x] = True

# --- Influence : portée en coût de déplacement, départagée au plus « proche » relatif -
best = np.full(COST.shape, np.inf); OWNER = np.full(COST.shape, -1)
for i, v in enumerate(v2):
    budget = float(v['r'])                       # 6 à 14 « cases de plaine »
    span = int(budget / (ROAD_FACTOR * 1.0)) + 4
    y1, y2, x1, x2 = max(0, v['y'] - span), min(NY, v['y'] + span + 1), max(0, v['x'] - span), min(NX, v['x'] + span + 1)
    sub = COST_R[y1:y2, x1:x2].copy()
    starts = [(y - y1, x - x1) for y, x in BUILT[i] if sub[y - y1, x - x1] > 0]
    if not starts:
        continue
    mcp = MCP_Geometric(sub)
    cum, _ = mcp.find_costs(starts)
    norm = cum / budget
    window = best[y1:y2, x1:x2]; own = OWNER[y1:y2, x1:x2]
    better = (norm <= 1.0) & (norm < window)
    window[better] = norm[better]; own[better] = i
ORG = np.where(OWNER >= 0, np.array([v['civ'] for v in v2])[np.maximum(OWNER, 0)], -1)

# Territoires en cercles, pour comparaison
r_cell = np.array([v['r'] for v in v2])[lab0]
CIRC = np.where((dist0 <= r_cell) & LAND, np.array([v['civ'] for v in v2])[lab0], -1)
CIRC_OWNER = np.where(CIRC >= 0, lab0, -1)

print('routes : %d cases' % ROADS.sum())
print('surface revendiquée : cercles %d cases, organique %d cases' % ((CIRC >= 0).sum(), (ORG >= 0).sum()))

# --- Rendu ---------------------------------------------------------------------------
def render(terr, owner, roads, scale, box):
    y1, y2, x1, x2 = box
    base = np.asarray(Image.open('c1_apres.png').convert('RGB'), np.float32)[y1 * 4:y2 * 4, x1 * 4:x2 * 4]
    img = np.asarray(Image.fromarray(base.astype(np.uint8)).resize(((x2 - x1) * scale, (y2 - y1) * scale), Image.BOX), np.float32).copy()
    t = np.repeat(np.repeat(terr[y1:y2, x1:x2], scale, 0), scale, 1)
    o = owner[y1:y2, x1:x2]
    edge = np.zeros(o.shape, bool)
    for dy, dx in ((0, 1), (1, 0), (0, -1), (-1, 0)):
        sh = np.roll(np.roll(o, dy, 0), dx, 1)
        edge |= (o >= 0) & (sh != o)
    e = np.repeat(np.repeat(edge, scale, 0), scale, 1)
    for c in range(len(COLORS)):
        msk = t == c
        img[msk] = img[msk] * 0.6 + COLORS[c] * 0.4
        img[msk & e] = COLORS[c] * 0.55
    if roads is not None:
        r = np.repeat(np.repeat(roads[y1:y2, x1:x2], scale, 0), scale, 1)
        img[r] = (176, 140, 92)
    bm = np.repeat(np.repeat(BUILT_MASK[y1:y2, x1:x2], scale, 0), scale, 1)
    img[bm] = (78, 58, 44)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))

def _font(size=18):
    for name in ('DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'arial.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()
FONT = _font()
c0 = max(range(5), key=lambda c: sum(v['civ'] == c for v in v2))
pts = np.array([(v['y'], v['x']) for v in v2 if v['civ'] == c0]); cy, cx = pts.mean(0).astype(int)
half = 75
box = (max(0, cy - half), min(NY, cy + half), max(0, cx - half), min(NX, cx + half))
a = render(CIRC, CIRC_OWNER, None, 5, box)
b = render(ORG, OWNER, ROADS, 5, box)
W, Hh = a.size
out = Image.new('RGB', (W * 2 + 14, Hh + 40), (20, 20, 26))
out.paste(a, (0, 40)); out.paste(b, (W + 14, 40))
d = ImageDraw.Draw(out)
d.text((10, 10), 'Territoires en cercles', fill=(235, 235, 235), font=FONT)
d.text((W + 24, 10), 'Territoires organiques : relief, forêts, rivières et routes', fill=(235, 235, 235), font=FONT)
out.save('territoires.png')
print('image', out.size)
