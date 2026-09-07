# Tunniplaani süsteem: ülevaade

Kaks osa. Esimene selgitab lihtsalt, kuidas asi töötab. Teine on avaldamise selgitus, ehk küsimus, kus see süsteem päriselt elama peaks. Hetkel veel otsustamata.

---

# I osa. Kuidas töötab

**Eesmärk:** Kiviõli Riigikooli tunniplaan asub kas kodulehel või muul sobival aadressil ja uueneb automaatselt. Muudatused tehakse mujal.

## Samm-sammult

1. **Kool teeb tunniplaani aSc-s**, nagu praegugi. aSc lükkab plaani EduPage'i.

2. **Skript küsib EduPage'ilt andmed** – tunniplaani ja asendused tänasest kaks nädalat ette. Sisselogimist ei ole vaja, EduPage'i avalik liides annab kõik välja. Nii ei ole ka aSc lisalitsentsi vaja, mida koolil ei ole.

3. **Skript teisendab andmed** oma kujule: klassid, õpetajad, ruumid, tunnid, kellaajad.
   Arvutab õiged ajad – 40 min juhendatud üksiktund, 75 min topelttund, ülejäänu iseseisev töö.

4. **Skript genereerib valmis HTML-lehed** kausta `dist/`: eraldi leht iga klassi, iga õpetaja ja iga ruumi jaoks, pluss avaleht. Mõlemale õppekohale (Viru ja Kiviõli tee 25) omaette komplekt.

5. **Asendused pannakse peale:** punase äärega kast lehe ülal, tundidel punane joon all ja hüüumärk nurgas. Leht näitab kolme nädalat, mille vahel saab liikuda.

6. **Failid lähevad kooli kodulehele.** See samm on veel tegemata, vt II osa.


## Käsud

```bash
node edupage-generate.mjs koik                # molemad oppekohad, tanane kuupaev
node edupage-generate.mjs viru                # ainult Viru
node edupage-generate.mjs viru 2026-05-25     # konkreetne kuupaev (asenduste jaoks)
```

## Mis veel puudu, et päriselt tööle hakkaks

1. **Kool peab 2026/2027 plaani EduPage'is ära tegema.** Seisuga 23.08.2026 on mõlema õppekoha uusim plaan eelmisest õppeaastast ja kehtis kuni 09.06.2026. Kuni uut plaani ei ole, ei ole midagi avaldada.

2. **Ajastus.** Miski peab skripti ise käivitama ja tuvastama, kas midagi muutus.

3. **Avaldamine.** Teadmata, millel kooli koduleht töötab ja kuidas failid sinna saavad.

Punktid 2 ja 3 on II osa teema.

---

# II osa. Avaldamine: kus süsteem elab ja kus võiks elada

## Kus see praegu elab

**Otsustatud 30.08.2026: lahendus B, GitHub Pages.** Repo `github.com/Kivioli-Riigikool/tunniplaan`, leht `https://kivioli-riigikool.github.io/tunniplaan/`. Generaator jookseb GitHub Actionsis koolipäeviti iga 5 min tagant, EduPage'ini pääseb Cloudflare Workeri kaudu. Käsitsi ei pea midagi tegema.

| Osa | Kus | Kelle oma |
|---|---|---|
| Andmed (tunniplaan, asendused) | `kivioli1keskkool.edupage.org`, `kiviol1keskkool.edupage.org` | Kool / aSc |
| Generaator | GitHub Actions, Cloudflare Workeri kaudu | Repo omanik |
| Valmis HTML | GitHub Pages | Repo omanik |

Repo on esialgu isikliku konto all. Kui kool tahab omanikuks saada, tuleb repo üle kanda ja DNS-i CNAME uuesti tellida – vt allpool.

Andmebaasi ei ole. Iga jooksuga küsitakse värsked andmed ja `dist/` kirjutatakse nullist üle.

---

## Kaks rolli, mida ei tohi segamini ajada

**Jooksutaja** käivitab generaatorit ajakava järgi.
**Hostija** serveerib valmis HTML-i külastajale.

Need ei pea olema sama teenus ja tõenäoliselt ei olegi.

---

## Generaator vajab Node'i

`edupage-generate.mjs` kasutab `laeRenderdaja()`-s `new Function`-it. See skript loeb `tunniplaan.html`-ist skriptiploki tekstina välja ja käivitab selle. Tänu sellele kandub vidina välimuse parandus automaatselt
ka genereeritud lehtedele.

> **Generaator peab jooksma Node'is.** Kas GitHub Actions või kooli server Node'iga,või kohalik masin.

---

## Kaks lahendust

Genereerimine on mõlemal juhul sama: GitHub Actions jookseb ajakava või muudatuse järgi, käivitab skripti, saab `dist/` kätte. Erineb ainult see, kuhu `dist/` läheb.

```
GitHub Actions -> node edupage-generate.mjs -> dist/ -> A. kooli koduleht
                                                     -> B. GitHub Pages
```

---

## A. Kooli koduleht, alamkataloog `/tunniplaan/`

Eelistatud lahendus. Tunniplaan on kooli enda aadressil `kool.ee/tunniplaan/`, ilma iframe'ita, ilma välise teenuseta. Külastaja ei näe, et seda genereeritakse mujal.

Kooli server ei pea oskama midagi peale staatiliste failide serveerimise. Node'i sinna vaja ei ole, andmebaasi ei ole, PHP-d ei ole. 291 faili, umbes 3 MB.

Ligipääsuks on kolm võimalust, tugevuse järjekorras.

### A1. Actions lükkab failid FTP/SFTP-ga (soovitatud)

```
GitHub Actions -> rsync/SFTP -> kool.ee/tunniplaan/
```

Vaja on ainult kontot, millel on kirjutusõigus ühte kausta. Parool või SSH-võti läheb GitHubi secrets'isse. Avaldamise sagedusele piiri ei ole.

**Küsi eraldi kontot ainult sellele kaustale.** 

### A2. Kooli server tõmbab ise

Kui kooli IT ei taha väljastpoolt ligipääsu anda – riigikooli puhul täiesti mõistlik hoiak – avaldame failid mingile aadressile, kooli serveris on cron, mis tõmbab ja lahti pakib. Piisab `curl`-ist ja `unzip`-ist.

### A3. Generaator jookseb kooli serveris

Ei ole soovitatud tee, aga kui seda pakutakse, siis siin on täpne nimekiri, mille vastu
serverit kontrollida. Ilma kõigi punktideta see ei tööta.

**Kohustuslik**

| Nõue | Miks |
|---|---|
| **Node 20 või uuem** | Vaja on globaalset `fetch`-i (Node 18+) ja ESM-i. Testitud Node 22 peal. Node 18 on eluea lõpus, ära sellega alusta. |
| **Väljuv HTTPS `*.edupage.org` pihta, port 443** | Siit tulevad kõik andmed. **See on kõige tõenäolisem koht, kus jagatud majutus ära ütleb** – paljud blokeerivad väljuvad ühendused või lubavad ainult lubatud aadresse. Küsi seda esimesena. |
| **Cron või systemd timer** | Muidu ei käivita keegi seda. |
| **Kirjutusõigus väljundkausta ja õigus see kustutada** | Iga jooks teeb `rmSync` + loob uuesti. |
| **`new Function` lubatud** | Node'is vaikimisi jah. Katki ainult siis, kui käivitatakse lipuga `--disallow-code-generation-from-strings`. Praktikas ei juhtu, aga kui `laeRenderdaja()` viskab veateate koodigenereerimise kohta, siis on põhjus see. |
| **UTF-8 failisüsteem ja `LANG`** | Sisus on täpitähed. Failinimed slugitakse ASCII-ks, seega failinimede pärast muretsema ei pea. |

**Mida vaja EI ole**

- npm-i, `node_modules`-i, `package.json`-i. Sõltuvusi ei ole ühtegi.
- Build-sammu. Kopeerid failid kohale ja käivitad.
- Andmebaasi.
- Püsivat protsessi. Skript käivitub, teeb töö ära, lõpetab.

---

## B. GitHub Pages

Varulahendus, kui kooli serverisse faile panna ei saa. Aadress on kujul
`<kasutaja>.github.io/<repo>/`, oma domeeniga saab selle ka viisakamaks teha.

Koduleht lingib sinna.

Piirid, mis loevad:

| Piir | Kas mahume |
|---|---|
| ~10 build'i tunnis | `*/10` koolipäeval teeb 6 tunnis, mahub |
| 1 GB sait | Väljund on 3 MB |
| 100 GB liiklust kuus | Koolile kordades piisav |

Ehk asendused saab ikkagi 10-minutise sammuga värskena hoida. Cloudflare'i, Netlify't ega
Vercelit siia vaja ei ole – need lisaksid ühe konto ja ühe platvormi juurde, ilma et midagi
võidaks.

### Mis on tehtud

- `dist/index.html` – saidi juurleht, valik kahe õppekoha vahel. Genereeritakse koos ülejäänuga.
- `.github/workflows/avalda.yml` – genereerib ja avaldab. Push'i peale, koolipäeviti iga 5 min ja käsitsi.
- `vahendaja/` – Cloudflare Worker, ilma milleta Actions EduPage'ini ei pääse.
- Aegunud plaani puhul on lehel punase äärega hoiatuskast. Avaldamist see ei peata.

### Jooksutaja: miks vahendaja vahel on

Algne plaan oli, et Actions küsib EduPage'ilt otse. **See ei tööta: EduPage ei võta GitHubi runneri IP-ga ühendust vastu.** Mõõdetud 30.08.2026 – DNS lahendub, muu internet toimib, aga port 443 EduPage'i pihta läheb timeouti nii IPv4 kui IPv6 peal. Blokk on TCP tasemel.

GitHubi aadressiruumi avamist küsida ei ole mõtet: Actionsi IP-nimekirjas on 5625 IPv4-vahemikku, üle 28 miljoni aadressi, ja see nimekiri muutub.

Cloudflare'i võrgust sama päring töötab. Seega on vahel Worker, mis päringu edasi annab: lubatud on kaks hosti, kaks teed ja POST, ning ilma võtmeta ei vastata midagi. Ülalpidamiskulu null, Cloudflare'i tasuta pakett katab selle mitmekordselt.

**Mida see juurde toob:** ühe konto ja ühe komponendi, mis võib katki minna. Kui Worker sureb, kukub jooks läbi ja vana leht jääb alles – vaikset valeandmete avaldamist ei teki. Kui generaator kunagi kooli serverisse kolib, kaob vahendaja vajadus ära: piisab GitHubi secreti eemaldamisest, koodi muuta ei ole vaja.

Kui A-lahendus (kooli koduleht) hiljem siiski avaneb, jääb kogu see töö alles: A on lihtsalt üks lisasamm `avalda.yml`-i lõpus, mis lükkab sama `dist/` rsync'iga kooli serverisse.

---

