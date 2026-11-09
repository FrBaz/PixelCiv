# Prototype de la séance C1 (docs/design/C1-monde.md) : océan, lacs par bilan hydrique,
# côtes typées et zones humides.
#
# Usage : dans testMap_filtre.ipynb, exécuter ce script juste après la cellule 33
# (calcul de BIOME_MAP) et avant les cellules de rendu (41 à 48), dans le même espace
# de noms : il lit HEIGHT_MAP, TEMPERATURE_MAP, MOISTURE_MAP, CONTINENTALNESS_MAP,
# river_map_render, BIOME_MAP, TERRAIN_TILES, BIOME_COLORS, make_cross_tile et
# make_biome_tiles, remplace BIOME_MAP et ajoute les tuiles des nouveaux biomes.
# Il enregistre ses couches dans c1_masks.pkl pour le script des saisons.
#
# Référence pour le portage en phase 1, pas code de production : boucles Python,
# pas de continuité est-ouest, seuils calés sur la carte de test.

# Paramètres (calés sur la carte de test, à recalibrer en phase 1)
OCEAN_MIN = 1500      # taille minimale d'une mer fermée (la carte de test n'a pas d'océan mondial)
A_MIN_P = 60          # surface minimale d'un lac (cases)
D_MIN_P = 0.012       # profondeur minimale d'un lac
EVAP0_P = 2.5         # coefficient d'évaporation
WET_SLOPE_Q = 0.40    # zones humides : quantile de pente
WET_DIST = 4          # zones humides : distance maximale à l'eau (cases)
WET_MO = 0.52         # zones humides : humidité minimale
WET_LOW = 0.08        # zones humides : hauteur maximale au-dessus de la mer
WET_NOISE = 0.35      # zones humides : seuil du bruit qui découpe les taches

import heapq, pickle, random as _r
import numpy as np
from scipy import ndimage

SEA = SEA_LEVEL
H = np.array(HEIGHT_MAP, dtype=np.float64)
TC = (np.array(TEMPERATURE_MAP, dtype=np.float64) - 0.46) * 100.0   # °C (formule du prototype)
MO = np.array(MOISTURE_MAP, dtype=np.float64)
CO = np.array(CONTINENTALNESS_MAP, dtype=np.float64)
RIV = np.array(river_map_render, dtype=bool)
B = np.array(BIOME_MAP, dtype=object)
NY, NX = H.shape
K8 = np.ones((3, 3), dtype=bool)

# ------------------------------------------------------------------
# D9 — Océan : seules les eaux reliées à l'océan mondial sont à son niveau.
# Ici (carte découpée, 80 % de terres), on retient les masses d'eau > 10 000 cases.
# ------------------------------------------------------------------
water = H <= SEA
lab, n = ndimage.label(water, structure=K8)
sizes = np.bincount(lab.ravel())
ocean_ids = [i for i in range(1, n + 1) if sizes[i] >= OCEAN_MIN]
OCEAN = np.isin(lab, ocean_ids)

# ------------------------------------------------------------------
# Priority flood depuis l'océan seul : les bassins fermés (même sous le
# niveau de la mer) deviennent des dépressions à remplir.
# ------------------------------------------------------------------
F = H.copy()
recv = np.full(NY * NX, -1, dtype=np.int64)
order = []
seen = OCEAN.copy()
heap = [(H[y, x], y * NX + x) for y, x in zip(*np.nonzero(OCEAN))]
heapq.heapify(heap)
nbr = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
while heap:
    e, i = heapq.heappop(heap)
    y, x = divmod(i, NX)
    for dx, dy in nbr:
        nx_, ny_ = x + dx, y + dy
        if 0 <= nx_ < NX and 0 <= ny_ < NY and not seen[ny_, nx_]:
            seen[ny_, nx_] = True
            j = ny_ * NX + nx_
            F[ny_, nx_] = max(H[ny_, nx_], e)
            recv[j] = i
            order.append(j)
            heapq.heappush(heap, (F[ny_, nx_], j))

# Accumulation du ruissellement (pondérée par l'humidité, qui sert de précipitation)
acc = (MO.ravel() * 1.0).copy()
for j in reversed(order):
    r = recv[j]
    if r >= 0 and not OCEAN.flat[r]:
        acc[r] += acc[j]
ACC = acc.reshape(NY, NX)

# ------------------------------------------------------------------
# D1 — Lacs par bilan hydrique
# ------------------------------------------------------------------
DEPTH = F - H
basin = (DEPTH > 1e-6) & ~OCEAN
blab, nb = ndimage.label(basin, structure=K8)
A_MIN = A_MIN_P
EVAP0 = EVAP0_P
LAKE = np.zeros_like(H, dtype=np.uint8)   # 0 aucun, 1 eau douce, 2 lac salé, 3 salar
SMALL_DEP = np.zeros_like(H, dtype=bool)
stats = {'douce': 0, 'salé': 0, 'salar': 0, 'petites dépressions': 0}
idx_all = ndimage.find_objects(blab)
for k, sl in enumerate(idx_all, start=1):
    if sl is None:
        continue
    m = blab[sl] == k
    area = int(m.sum())
    ys, xs = np.nonzero(m)
    ys = ys + sl[0].start; xs = xs + sl[1].start
    if area < A_MIN or DEPTH[ys, xs].max() < D_MIN_P:
        SMALL_DEP[ys, xs] = True
        stats['petites dépressions'] += 1
        continue
    inflow = ACC[ys, xs].max()                      # ruissellement du bassin versant
    t = TC[ys, xs].mean()
    evap = area * EVAP0 * max(0.05, (t + 10.0) / 40.0) * (1.2 - MO[ys, xs].mean())
    rho = inflow / max(evap, 1e-9)
    if rho >= 1.0:
        LAKE[ys, xs] = 1; stats['douce'] += 1
    else:
        hs = H[ys, xs]; o = np.argsort(hs)
        if rho < 0.12:
            kk = max(A_MIN, int(0.35 * area)); LAKE[ys[o[:kk]], xs[o[:kk]]] = 3; stats['salar'] += 1
        else:
            kk = max(A_MIN, int(rho * area)); LAKE[ys[o[:kk]], xs[o[:kk]]] = 2; stats['salé'] += 1

LAKE_DEEP = (LAKE == 1) & (DEPTH >= 0.012)

# ------------------------------------------------------------------
# Pente locale et proximité de l'eau
# ------------------------------------------------------------------
gy, gx = np.gradient(H)
SLOPE = np.hypot(gx, gy)
LAND = ~OCEAN & (LAKE == 0)
near_ocean = ndimage.binary_dilation(OCEAN, structure=K8) & LAND
WET_SRC = (LAKE > 0) | RIV | OCEAN
dist_water = ndimage.distance_transform_edt(~WET_SRC)
relief5 = ndimage.maximum_filter(H, size=5) - SEA

# ------------------------------------------------------------------
# D3 — Types de côtes (une seule rangée de cases côtières)
# ------------------------------------------------------------------
COAST = np.zeros_like(H, dtype=object); COAST[:] = None
cr = relief5[near_ocean]
CLIFF_T = np.quantile(cr, 0.88); ROCK_T = np.quantile(cr, 0.70)
flat_q = np.quantile(SLOPE[LAND], 0.35)
for y, x in zip(*np.nonzero(near_ocean)):
    t, mo, rl, sl = TC[y, x], MO[y, x], relief5[y, x], SLOPE[y, x]
    if rl >= CLIFF_T:
        COAST[y, x] = 'cliff'
    elif t < 3 or rl >= ROCK_T:
        COAST[y, x] = 'rocky_coast'
    elif t >= 24 and mo >= 0.62 and sl <= flat_q:
        COAST[y, x] = 'mangrove'
    elif 8 <= t < 24 and mo >= 0.66 and sl <= flat_q:
        COAST[y, x] = 'salt_marsh'
    else:
        COAST[y, x] = 'beach'

# ------------------------------------------------------------------
# D2 — Zones humides intérieures
# ------------------------------------------------------------------
rng = np.random.default_rng(7)
noise = ndimage.gaussian_filter(rng.random(H.shape), 2.0)
noise = (noise - noise.min()) / (noise.max() - noise.min())
lowland = (H - SEA) < WET_LOW
WET = (LAND & ~near_ocean & (SLOPE <= np.quantile(SLOPE[LAND], WET_SLOPE_Q)) &
       ((dist_water <= WET_DIST) | SMALL_DEP) & lowland & (MO >= WET_MO) & (noise > WET_NOISE))
WET = ndimage.binary_opening(WET, structure=np.ones((2, 2)))   # pas de cases isolées
WTYPE = np.zeros_like(H, dtype=object); WTYPE[:] = None
WTYPE[WET & (TC < 3)] = 'bog'
WTYPE[WET & (TC >= 3) & (TC < 22)] = 'marsh'
WTYPE[WET & (TC >= 22)] = 'swamp'

# ------------------------------------------------------------------
# Reclassement des anciennes plages qui ne touchent pas la mer
# (logique climatique du prototype, sans la règle « altitude < mer + 0,03 »)
# ------------------------------------------------------------------
def climate_biome(t, mo):
    if t >= 25 and mo < 0.25: return 'desert'
    if t >= 10 and mo < 0.18: return 'desert'
    if t <= 0: return 'tundra' if mo < 0.35 else 'snow'
    if t <= 5: return 'tundra' if mo < 0.35 else 'taiga'
    if t <= 10: return 'cold_steppe' if mo < 0.30 else ('taiga' if mo < 0.65 else 'cold_forest')
    if t <= 18:
        if mo < 0.25: return 'steppe'
        if mo < 0.45: return 'grassland'
        return 'temperate_forest' if mo < 0.70 else 'temperate_rainforest'
    if t <= 25:
        if mo < 0.25: return 'savanna'
        if mo < 0.50: return 'tropical_grassland'
        return 'tropical_forest' if mo < 0.75 else 'rainforest'
    if mo < 0.25: return 'desert'
    if mo < 0.45: return 'savanna'
    return 'tropical_forest' if mo < 0.75 else 'rainforest'

NB = B.copy()
was_sand = (B == 'sand')
for y, x in zip(*np.nonzero(was_sand & ~near_ocean)):
    NB[y, x] = climate_biome(TC[y, x], MO[y, x])
NB[OCEAN & (B == 'sand')] = 'coastal_ocean'
# Eaux fermées : ce ne sont plus des océans
closed_water = water & ~OCEAN
for y, x in zip(*np.nonzero(near_ocean)):
    NB[y, x] = COAST[y, x]
for y, x in zip(*np.nonzero(WET)):
    NB[y, x] = WTYPE[y, x]
NB[LAKE == 1] = 'lake_shallow'
NB[LAKE_DEEP] = 'lake_deep'
NB[LAKE == 2] = 'salt_lake'
NB[LAKE == 3] = 'salt_flat'
# Bassins fermés trop arides pour se remplir : restent émergés
dry_closed = closed_water & (LAKE == 0)
for y, x in zip(*np.nonzero(dry_closed)):
    NB[y, x] = climate_biome(TC[y, x], MO[y, x])

# Les rivières ne se dessinent pas dans les lacs
for y, x in zip(*np.nonzero(LAKE > 0)):
    river_map_render[y][x] = False

# ------------------------------------------------------------------
# Tuiles des nouveaux biomes (palettes provisoires)
# ------------------------------------------------------------------
NEW_COLORS = {
    'lake_deep':    [(40, 104, 168), (46, 112, 176), (42, 108, 172)],
    'lake_shallow': [(74, 148, 204), (82, 158, 210), (78, 152, 206)],
    'salt_lake':    [(96, 190, 186), (112, 202, 196), (104, 196, 190)],
    'salt_flat':    [(222, 220, 210), (234, 231, 222), (212, 208, 198)],
    'marsh':        [(86, 128, 72), (100, 140, 80), (72, 128, 118)],
    'bog':          [(112, 108, 80), (126, 118, 88), (98, 106, 92)],
    'swamp':        [(30, 92, 60), (40, 106, 66), (48, 104, 98)],
    'mangrove':     [(36, 108, 78), (52, 124, 84), (58, 128, 120)],
    'salt_marsh':   [(116, 146, 92), (128, 156, 98), (98, 140, 120)],
    'beach':        [(235, 219, 127), (240, 226, 140), (228, 211, 118)],
    'rocky_coast':  [(140, 134, 120), (156, 150, 134), (124, 120, 110)],
    'cliff':        [(116, 106, 96), (132, 122, 110), (102, 96, 88)],
}
for k_, cols in NEW_COLORS.items():
    if k_.startswith('lake') or k_ == 'salt_lake':
        TERRAIN_TILES[k_] = [make_cross_tile(cols[0]), make_cross_tile(cols[1])]
    else:
        TERRAIN_TILES[k_] = make_biome_tiles(cols, seed_offset=hash(k_) % 1000)
    BIOME_COLORS[k_] = cols[0]

BIOME_MAP = NB.tolist()

land_n = int((~water).sum())
summary = {
    'lacs': stats,
    'cases de lac (douce/salé/salar)': [int((LAKE == i).sum()) for i in (1, 2, 3)],
    'zones humides (cases)': {t_: int((WTYPE == t_).sum()) for t_ in ('marsh', 'bog', 'swamp')},
    'côtes (cases)': {t_: int((COAST == t_).sum()) for t_ in ('beach', 'rocky_coast', 'cliff', 'mangrove', 'salt_marsh')},
    'plage avant (% terres)': round(float(was_sand.sum()) / land_n * 100, 1),
    'plage après (% terres)': round(float((NB == 'beach').sum()) / land_n * 100, 1),
    'masses d eau fermées': int(n - len(ocean_ids)),
}
print(summary)
pickle.dump({'NB': NB, 'TC': TC, 'MO': MO, 'CO': CO, 'H': H, 'LAKE': LAKE, 'OCEAN': OCEAN,
             'RIV': np.array(river_map_render, dtype=bool), 'B_before': B, 'summary': summary},
            open('c1_masks.pkl', 'wb'))
