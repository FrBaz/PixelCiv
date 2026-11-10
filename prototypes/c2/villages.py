# Prototype de la séance C2, seconde version : un village grandit et défriche autour de lui
# avant d'essaimer ; l'espacement découle du budget de population.
# Compare avec la première version (colonies à intervalles fixes, 12 cases d'écart).
# Usage : à côté de c1_masks.pkl et c1_apres.png, produits par les scripts de C1
# (prototypes/c1/). Référence pour la phase 3, pas code de production.
import pickle, numpy as np
from scipy import ndimage
from PIL import Image, ImageDraw, ImageFont

m = pickle.load(open('c1_masks.pkl', 'rb'))
NB, TC, H, LAKE, OCEAN, RIV = m['NB'], m['TC'], m['H'], m['LAKE'], m['OCEAN'], m['RIV']
NY, NX = H.shape
SEA = 0.45

FERTILITY = {
    'grassland': 1.0, 'temperate_forest': 0.8, 'tropical_grassland': 0.7, 'steppe': 0.6,
    'savanna': 0.6, 'tropical_forest': 0.6, 'temperate_rainforest': 0.6, 'cold_forest': 0.5,
    'rainforest': 0.45, 'marsh': 0.4, 'cold_steppe': 0.35, 'taiga': 0.35, 'beach': 0.3,
    'swamp': 0.3, 'salt_marsh': 0.3, 'mountain': 0.2, 'mangrove': 0.2, 'alpine': 0.15,
    'bog': 0.15, 'rocky_coast': 0.15, 'tundra': 0.1, 'cliff': 0.1, 'desert': 0.05,
}
UNBUILDABLE = {'coastal_ocean', 'ocean', 'deep_ocean', 'river', 'lake_deep', 'lake_shallow',
               'salt_lake', 'salt_flat', 'snow', 'glacier', 'marsh', 'bog', 'swamp', 'mangrove',
               'salt_marsh', 'cliff', 'high_mountain'}
FORESTS = {'temperate_forest', 'tropical_forest', 'temperate_rainforest', 'cold_forest',
           'rainforest', 'taiga', 'swamp', 'mangrove'}

hn = np.clip((H - SEA) / (1 - SEA), 0, 1)
ALT = 7000 * hn ** 1.6
alt_factor = np.where(ALT < 400, 1.0, np.where(ALT < 1000, 0.8, np.where(ALT < 1800, 0.5, 0.0)))
FERT = np.vectorize(lambda b: FERTILITY.get(b, 0.0))(NB) * alt_factor
F_AVG = ndimage.uniform_filter(FERT, size=9)
fresh = RIV | (LAKE == 1)
d_fresh = ndimage.distance_transform_edt(~fresh)
WATER = np.where(d_fresh <= 1.5, 1.0, np.where(d_fresh <= 3, 0.7, np.where(d_fresh <= 6, 0.35, 0.1)))
COAST = ndimage.binary_dilation(OCEAN, structure=np.ones((3, 3))) & ~OCEAN
WOOD = ndimage.uniform_filter(np.isin(NB, list(FORESTS)).astype(float), size=11)
T = TC - 8.0
comfort = np.clip(1 - np.maximum(0, np.maximum(4 - T, T - 26)) / 12.0, 0, 1)
BUILDABLE = ~np.isin(NB, list(UNBUILDABLE)) & (ALT < 1800)
SCORE = np.clip(comfort * (0.5 * F_AVG + 0.5 * WATER) + 0.1 * COAST + 0.1 * np.minimum(WOOD * 2, 1), 0, 1)
SCORE[~BUILDABLE] = 0
LAND = ~OCEAN & (LAKE == 0)
YY, XX = np.mgrid[0:NY, 0:NX]

def founders(rng, n_bands=5, band_range=20, min_gap=60):
    land_idx = np.argwhere(BUILDABLE & (SCORE > 0.2))
    out = []
    for _ in range(200):
        if len(out) == n_bands:
            break
        y0, x0 = land_idx[rng.integers(len(land_idx))]
        y1, y2 = max(0, y0 - band_range), min(NY, y0 + band_range + 1)
        x1, x2 = max(0, x0 - band_range), min(NX, x0 + band_range + 1)
        win = SCORE[y1:y2, x1:x2]
        yy, xx = np.unravel_index(np.argmax(win), win.shape)
        y, x = y1 + yy, x1 + xx
        if SCORE[y, x] >= 0.5 and all((y - a) ** 2 + (x - b) ** 2 >= min_gap ** 2 for a, b in out):
            out.append((y, x))
    return out

def best_site(vy, vx, villages, rmin, rmax, excl, smin=0.40):
    d2 = (YY - vy) ** 2 + (XX - vx) ** 2
    cand = (d2 >= rmin ** 2) & (d2 <= rmax ** 2) & (SCORE >= smin)
    if not cand.any():
        return None
    occ = np.zeros_like(cand)
    for v in villages:
        occ |= (YY - v['y']) ** 2 + (XX - v['x']) ** 2 < excl ** 2
    cand &= ~occ
    if not cand.any():
        return None
    s = np.where(cand, SCORE, -1)
    return np.unravel_index(np.argmax(s), s.shape)

def voronoi(villages):
    seeds = np.ones(H.shape, dtype=bool); idmap = np.full(H.shape, -1)
    for i, v in enumerate(villages):
        seeds[v['y'], v['x']] = False; idmap[v['y'], v['x']] = i
    dist, (iy, ix) = ndimage.distance_transform_edt(seeds, return_indices=True)
    return dist, idmap[iy, ix]

# ------------------------------------------------------------------ version 1
rng = np.random.default_rng(42)
v1 = [dict(y=y, x=x, civ=c, pop=0, founder=True) for c, (y, x) in enumerate(founders(rng))]
for rnd in range(1, 15):
    for k in rng.permutation(len(v1)):
        if rng.random() > 0.45:
            continue
        s = best_site(v1[k]['y'], v1[k]['x'], v1, 8, 25, 12)
        if s is not None:
            v1.append(dict(y=s[0], x=s[1], civ=v1[k]['civ'], pop=0, founder=False))

# ------------------------------------------------------------------ version 2
# Paramètres proposés
YEARS = 300
GROWTH = 0.04            # croissance annuelle sans contrainte
PEOPLE_PER_FERT = 1.0    # habitants qu'une case de fertilité 1 peut nourrir
R_START, R_MAX = 6, 14   # rayon du territoire : au départ, et au plus pour un village vivant de ses champs
EXPAND_AT = 0.70         # le village défriche plus loin dès qu'il utilise 70 % de ce que son territoire nourrit
SATURATED_AT = 0.90      # il essaime à 90 % quand il ne peut plus s'étendre, pendant deux ans
COL_MIN, COL_MAX = 22, 40
EXCLUSION = 25           # aucun établissement à moins de 25 cases d'une colonie
COLONISTS = 15           # 3 à 4 foyers
COOLDOWN = 10            # années entre deux essaimages d'un même village

rng = np.random.default_rng(42)
v2 = [dict(y=y, x=x, civ=c, pop=12.0, r=R_START, sat=0, cool=0, founder=True, born=0)
      for c, (y, x) in enumerate(founders(rng))]
history = []
for year in range(1, YEARS + 1):
    dist, lab = voronoi(v2)
    r_cell = np.array([v['r'] for v in v2])[lab]
    def capacity(extra):
        msk = LAND & (dist <= r_cell + extra)
        return np.bincount(lab[msk], weights=FERT[msk], minlength=len(v2)) * PEOPLE_PER_FERT
    K, K_next = capacity(0), capacity(1)
    new = []
    for i, v in enumerate(v2):
        k = max(K[i], 1.0)
        # croissance presque constante tant que la terre suffit, freinée seulement près de la limite
        v['pop'] += GROWTH * v['pop'] * (1 - (v['pop'] / k) ** 4)
        v['cool'] = max(0, v['cool'] - 1)
        can_expand = v['r'] < R_MAX and K_next[i] > K[i] * 1.03
        if v['pop'] >= EXPAND_AT * k and can_expand:
            v['r'] += 1; v['sat'] = 0                        # défrichement : le territoire s'étend
        elif v['pop'] >= SATURATED_AT * k and not can_expand:
            v['sat'] += 1                                    # plus de terre à défricher
        else:
            v['sat'] = 0
        if v['sat'] >= 2 and v['cool'] == 0:
            s = best_site(v['y'], v['x'], v2 + new, COL_MIN, COL_MAX, EXCLUSION)
            if s is not None:
                v['pop'] -= COLONISTS; v['cool'] = COOLDOWN; v['sat'] = 0
                new.append(dict(y=s[0], x=s[1], civ=v['civ'], pop=float(COLONISTS), r=R_START,
                                sat=0, cool=COOLDOWN, founder=False, born=year))
    v2 += new
    if year % 50 == 0:
        history.append((year, len(v2), int(sum(v['pop'] for v in v2))))

def nn_mean(vs):
    P = np.array([(v['y'], v['x']) for v in vs], float)
    d = np.sqrt(((P[:, None] - P[None]) ** 2).sum(-1)); np.fill_diagonal(d, 1e9)
    return d.min(1).mean()

pops = np.array([v['pop'] for v in v2])
classes = [('hameau', 0, 50), ('village', 50, 250), ('bourg', 250, 800), ('ville', 800, 2500)]
print('V1 :', len(v1), 'villages | écart moyen au plus proche voisin %.1f cases' % nn_mean(v1))
print('V2 :', len(v2), 'établissements | écart moyen %.1f cases | population %d' % (nn_mean(v2), pops.sum()))
print('V2 tailles :', {n: int(((pops >= a) & (pops < b)).sum()) for n, a, b in classes},
      '| population max %d, médiane %d' % (pops.max(), np.median(pops)))
print('V2 au fil du temps (année, établissements, population) :', history)
first_col = min([v['born'] for v in v2 if not v['founder']], default=None)
print('V2 première colonie : année', first_col)

# ------------------------------------------------------------------ images
def _font(size=18):
    for name in ('DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'arial.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()
FONT = _font()
COLORS = np.array([(230, 57, 70), (255, 183, 3), (69, 123, 157), (155, 93, 229), (241, 91, 181)], np.float32)
S = 2
BASE = np.asarray(Image.open('c1_apres.png').convert('RGB').resize((NX * S, NY * S), Image.BOX), np.float32)

def panel(vs, radius_of, built_of):
    dist, lab = voronoi(vs)
    rad = np.array([radius_of(v) for v in vs])[lab]
    civ = np.array([v['civ'] for v in vs])[lab]
    terr = np.where((dist <= rad) & LAND, civ, -1)
    t_up = np.repeat(np.repeat(terr, S, 0), S, 1)
    img = BASE.copy()
    for c in range(len(COLORS)):
        msk = t_up == c
        img[msk] = img[msk] * 0.55 + COLORS[c] * 0.45
    # zone bâtie : les cases constructibles les plus proches du centre
    built = np.zeros(H.shape, bool)
    for i, v in enumerate(vs):
        b = built_of(v)
        if b <= 0:
            continue
        rr = int(np.sqrt(b) * 1.6) + 3
        y1, y2, x1, x2 = max(0, v['y'] - rr), min(NY, v['y'] + rr + 1), max(0, v['x'] - rr), min(NX, v['x'] + rr + 1)
        sub = BUILDABLE[y1:y2, x1:x2] & (lab[y1:y2, x1:x2] == i)
        dd = (YY[y1:y2, x1:x2] - v['y']) ** 2 + (XX[y1:y2, x1:x2] - v['x']) ** 2
        idx = np.argsort(np.where(sub, dd, 1e9), axis=None)[:b]
        yy, xx = np.unravel_index(idx, sub.shape)
        ok = sub[yy, xx]
        built[y1 + yy[ok], x1 + xx[ok]] = True
    b_up = np.repeat(np.repeat(built, S, 0), S, 1)
    img[b_up] = (78, 58, 44)
    out = Image.fromarray(img.astype(np.uint8))
    d = ImageDraw.Draw(out)
    for v in vs:
        px, py = v['x'] * S + 1, v['y'] * S + 1
        if v['founder']:
            d.rectangle((px - 6, py - 6, px + 6, py + 6), fill=tuple(int(c) for c in COLORS[v['civ']]),
                        outline=(20, 20, 20), width=2)
        else:
            d.rectangle((px - 2, py - 2, px + 2, py + 2), fill=(255, 255, 255), outline=(20, 20, 20))
    return out

p1 = panel(v1, lambda v: 10, lambda v: 0)
p2 = panel(v2, lambda v: v['r'], lambda v: int(np.ceil(v['pop'] / 15)))
W, Hh = p1.size
canvas = Image.new('RGB', (W * 2 + 16, Hh + 44), (20, 20, 26))
canvas.paste(p1, (0, 44)); canvas.paste(p2, (W + 16, 44))
dd = ImageDraw.Draw(canvas)
dd.text((10, 12), f"Première version : colonies à intervalles fixes ({len(v1)} villages)", fill=(235, 235, 235), font=FONT)
dd.text((W + 26, 12), f"Seconde version : croissance d'abord, puis essaimage ({len(v2)} établissements)",
        fill=(235, 235, 235), font=FONT)
canvas = canvas.resize((canvas.width * 3 // 4, canvas.height * 3 // 4), Image.LANCZOS)
canvas.save('expansion.png')

# Zoom sur une civilisation de la seconde version, en pleine résolution
c0 = max(range(5), key=lambda c: sum(v['civ'] == c for v in v2))
pts = np.array([(v['y'], v['x']) for v in v2 if v['civ'] == c0])
cy, cx = pts.mean(0).astype(int)
z = panel(v2, lambda v: v['r'], lambda v: int(np.ceil(v['pop'] / 15)))
half = 70
box = (max(0, (cx - half) * S), max(0, (cy - half) * S), min(NX * S, (cx + half) * S), min(NY * S, (cy + half) * S))
z = z.crop(box); z = z.resize((z.width * 3, z.height * 3), Image.NEAREST)
z.save('zoom.png')
print('images ok', canvas.size, z.size)
