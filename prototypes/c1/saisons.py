# Prototype de la séance C1 (docs/design/C1-monde.md) : saisons.
# Calcule la température de chaque case pour chaque mois et recolore la carte rendue
# (neige, glace, feuillus, prairies, saison sèche des tropiques).
#
# Usage : après lacs_cotes_zones_humides.py et le rendu du notebook, enregistrer la
# carte rendue sous c1_apres.png à côté de c1_masks.pkl, puis lancer ce script.
# La recoloration par mélange de couleurs n'est qu'une maquette : le jeu utilisera
# un shader et des palettes saisonnières (décision D10).
import pickle, numpy as np
from PIL import Image, ImageDraw, ImageFont
def _font(size=15):
    for name in ('DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'arial.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()
FONT = _font()

m = pickle.load(open('c1_masks.pkl', 'rb'))
NB, TC, MO, CO, LAKE, OCEAN, RIV = m['NB'], m['TC'], m['MO'], m['CO'], m['LAKE'], m['OCEAN'], m['RIV']
NY, NX = TC.shape
BASE = np.asarray(Image.open('c1_apres.png').convert('RGB'), dtype=np.float32)

# --- Modèle climatique saisonnier -------------------------------------------
yy = (np.arange(NY) + 0.5) / NY
phi = np.abs(2 * yy - 1)[:, None] * np.ones((1, NX))        # 0 équateur, 1 pôles
north = (yy < 0.5)[:, None] * np.ones((1, NX), dtype=bool)
AMP = (1.0 + 15.0 * phi ** 1.3) * (0.75 + 0.5 * CO)           # demi-amplitude annuelle (°C)
SIGN = np.where(north, 1.0, -1.0)

def month_temp(mo):
    return TC + AMP * np.cos(2 * np.pi * (mo - 6.5) / 12.0) * SIGN

def local_month(mo):
    """Mois « vécu » : l'hémisphère sud est décalé de six mois."""
    return np.where(north, mo, (mo + 6) % 12)

rng = np.random.default_rng(3)
AUTUMN = np.array([(198, 120, 42), (176, 84, 36), (214, 170, 64), (160, 110, 50)], dtype=np.float32)
autumn_pick = AUTUMN[rng.integers(0, 4, size=(NY, NX))]

def up(a):
    """Agrandit une couche par case (NY, NX[, 3]) à la résolution des pixels (×4)."""
    return np.repeat(np.repeat(a, 4, axis=0), 4, axis=1)

LUM = BASE.mean(axis=2, keepdims=True) / 255.0
deciduous = np.isin(NB, ['temperate_forest', 'cold_forest', 'temperate_rainforest'])
forest = np.isin(NB, ['taiga', 'cold_forest', 'temperate_forest', 'temperate_rainforest',
                      'tropical_forest', 'rainforest', 'swamp', 'mangrove'])
grass = np.isin(NB, ['grassland', 'steppe', 'cold_steppe'])
tropical_grass = np.isin(NB, ['savanna', 'tropical_grassland'])
tundra = np.isin(NB, ['tundra', 'bog'])
fresh_water = (LAKE > 0) | RIV
sea_shallow = OCEAN & np.isin(NB, ['coastal_ocean'])
land = ~OCEAN & (LAKE == 0) & ~RIV

def blend(img, mask_f, color):
    """img (pix) ← img·(1-f) + color·f, f par case agrandi aux pixels."""
    f = up(mask_f.astype(np.float32))[..., None]
    col = color if color.ndim == 3 and color.shape[:2] == img.shape[:2] else (
        up(color) if color.ndim == 3 else color[None, None, :])
    return img * (1 - f) + col * f

def render_month(mo):
    T = month_temp(mo)
    lm = local_month(mo)
    img = BASE.copy()
    # Feuillus : printemps, automne, hiver sans feuilles
    spring = deciduous & np.isin(lm, [3, 4])
    img = blend(img, spring * 0.25, np.array((150, 200, 90), np.float32))
    autumn = deciduous & np.isin(lm, [8, 9, 10]) & (T < 16)
    img = blend(img, autumn * 0.6, autumn_pick)
    bare = deciduous & (np.isin(lm, [11, 0, 1, 2]) | (T < 4))
    img = blend(img, bare * 0.5, np.array((118, 104, 86), np.float32))
    # Prairies : herbe sèche en été, terne en hiver
    dry_summer = grass & np.isin(lm, [6, 7, 8]) & (MO < 0.55)
    img = blend(img, dry_summer * 0.35, np.array((196, 180, 96), np.float32))
    # Tropiques : saison sèche (hiver local) et saison des pluies
    dry = tropical_grass & np.isin(lm, [10, 11, 0, 1, 2, 3])
    img = blend(img, dry * 0.35, np.array((202, 172, 92), np.float32))
    wet = tropical_grass & np.isin(lm, [5, 6, 7, 8])
    img = blend(img, wet * 0.22, np.array((110, 172, 70), np.float32))
    # Toundra qui reverdit brièvement
    img = blend(img, (tundra & np.isin(lm, [6, 7])) * 0.2, np.array((140, 170, 110), np.float32))
    # Neige saisonnière (les forêts en gardent moins : les arbres dépassent)
    snow = np.clip((0.5 - T) / 3.0, 0, 1) * land
    snow = np.where(forest, snow * 0.7, snow)
    snow_col = np.clip(np.array((238, 244, 250), np.float32)[None, None, :] * (0.72 + 0.4 * LUM), 0, 255)
    img = blend(img, snow, snow_col)
    # Glace sur les lacs et rivières, banquise côtière
    ice = np.clip((-1.0 - T) / 3.0, 0, 1) * fresh_water
    img = blend(img, ice * 0.9, np.array((205, 226, 236), np.float32))
    seaice = np.clip((-6.0 - T) / 4.0, 0, 1) * sea_shallow
    img = blend(img, seaice * 0.85, np.array((216, 231, 241), np.float32))
    return np.clip(img, 0, 255).astype(np.uint8), T

MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août',
        'Septembre', 'Octobre', 'Novembre', 'Décembre']

# --- 1. Quatre saisons sur une zone du nord, en pleine résolution -------------
x0, y0, W, Hh = 300, 0, 160, 160
tiles = []
for mo in (0, 3, 6, 9):
    img, _ = render_month(mo)
    crop = Image.fromarray(img[y0 * 4:(y0 + Hh) * 4, x0 * 4:(x0 + W) * 4])
    d = ImageDraw.Draw(crop)
    d.rectangle((0, 0, 210, 28), fill=(20, 20, 26))
    d.text((8, 5), MOIS[mo] + ' (hémisphère nord)', fill=(240, 240, 240), font=FONT)
    tiles.append(crop)
w, h = tiles[0].size
grid = Image.new('RGB', (w * 2 + 10, h * 2 + 10), (20, 20, 26))
for k, t in enumerate(tiles):
    grid.paste(t, ((k % 2) * (w + 10), (k // 2) * (h + 10)))
grid.save('saisons-nord.png')

# --- 2. Animation des douze mois sur toute la carte (1 px = 1 case) ----------
frames = []
for mo in range(12):
    img, T = render_month(mo)
    fr = Image.fromarray(img).resize((512, 512), Image.BOX)
    canvas = Image.new('RGB', (512, 540), (20, 20, 26))
    canvas.paste(fr, (0, 28))
    d = ImageDraw.Draw(canvas)
    d.text((8, 5), f'{MOIS[mo]} : hiver au nord, été au sud' if mo in (0, 1, 11) else
           (f'{MOIS[mo]} : été au nord, hiver au sud' if mo in (5, 6, 7) else MOIS[mo]),
           fill=(240, 240, 240), font=FONT)
    frames.append(canvas.quantize(colors=200, method=Image.Quantize.MEDIANCUT))
frames[0].save('saisons.gif', save_all=True, append_images=frames[1:], duration=700, loop=0, optimize=True)

# --- Statistiques : couverture neigeuse des terres selon le mois --------------
for mo in (0, 3, 6, 9):
    T = month_temp(mo)
    sn = (T < 0.5) & land
    print(MOIS[mo], ': terres enneigées nord %.0f %% / sud %.0f %%' % (
        sn[:256].sum() / land[:256].sum() * 100, sn[256:].sum() / land[256:].sum() * 100))
w_ = TC + AMP; c_ = TC - AMP
print('mois le plus chaud < 10 °C (au-delà de la limite des arbres) : %.1f %% des terres' % ((w_ < 10)[land].mean() * 100))
print('mois le plus froid > 18 °C (climat tropical) : %.1f %% des terres' % ((c_ > 18)[land].mean() * 100))
