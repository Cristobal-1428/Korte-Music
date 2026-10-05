"""Transcribe con IA (Whisper, gratis y en tu propio PC) la letra de las canciones y la guarda en la API.

Instalación (una vez, aparte de requirements.txt):
    pip install faster-whisper httpx truststore

Uso:
    python tools/transcribe_lyrics.py                    # solo canciones sin letra
    python tools/transcribe_lyrics.py --ids 3 5          # solo esas canciones
    python tools/transcribe_lyrics.py --overwrite        # también reemplaza letras ya guardadas
    python tools/transcribe_lyrics.py --model medium     # más preciso y más lento (por defecto: small)

Variables: API_URL (por defecto la de producción) y ADMIN_KEY (la clave de administrador de Render).
Las canciones privadas se omiten. La primera vez se descarga el modelo (small ≈ 500 MB).
Las letras salen con tiempos ([0:12.50] frase); se corrigen a mano desde "Editar canción".
"""
import argparse
import os
import sys
import tempfile
from pathlib import Path

import httpx

try:  # redes que reemplazan el certificado (empresa, universidad): usar los certificados de Windows
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

DEFAULT_API = "https://korte-music.onrender.com"


def stamp(seconds: float) -> str:
    minutes, rest = divmod(max(seconds, 0), 60)
    return f"[{int(minutes)}:{rest:05.2f}]"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default=os.getenv("API_URL", DEFAULT_API).rstrip("/"))
    parser.add_argument("--ids", type=int, nargs="*", help="solo estas canciones")
    parser.add_argument("--overwrite", action="store_true", help="reemplaza letras ya guardadas")
    parser.add_argument("--model", default="small", help="tiny, base, small, medium, large-v3")
    parser.add_argument("--language", default="es", help="idioma de las canciones (es, en...; vacío = detectar)")
    args = parser.parse_args()

    key = os.getenv("ADMIN_KEY", "")
    if not key:
        print("Falta la variable ADMIN_KEY (la clave de administrador).", file=sys.stderr)
        return 1
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("Falta faster-whisper: pip install faster-whisper httpx truststore", file=sys.stderr)
        return 1

    headers = {"X-Admin-Key": key}
    with httpx.Client(timeout=120, follow_redirects=True, headers=headers) as http:
        songs = http.get(f"{args.api}/songs").json()
        todo = [s for s in songs if not s["is_private"] and (not args.ids or s["id"] in args.ids)]
        if not args.overwrite:
            todo = [s for s in todo if not s.get("has_lyrics")]
        if not todo:
            print("No hay canciones por transcribir.")
            return 0

        print(f"Cargando el modelo «{args.model}»...")
        model = WhisperModel(args.model, device="cpu", compute_type="int8")

        for song in todo:
            label = f"#{song['id']} {song['title']} – {song['artist']}"
            print(f"\n{label}\n  descargando el audio...")
            audio_url = song.get("audio_url") or f"{args.api}/songs/{song['id']}/stream"
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "audio"
                with http.stream("GET", audio_url) as res:
                    res.raise_for_status()
                    with open(path, "wb") as f:
                        for chunk in res.iter_bytes():
                            f.write(chunk)
                print("  transcribiendo...")
                segments, info = model.transcribe(
                    str(path), language=args.language or None, vad_filter=True, condition_on_previous_text=False
                )
                lines = [f"{stamp(seg.start)} {seg.text.strip()}" for seg in segments if seg.text.strip()]
            if not lines:
                print("  no se entendió ninguna palabra; se omite.")
                continue
            res = http.put(f"{args.api}/songs/{song['id']}/lyrics", data={"lyrics": "\n".join(lines)})
            res.raise_for_status()
            print(f"  listo: {len(lines)} líneas guardadas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
