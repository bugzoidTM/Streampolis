#!/usr/bin/env python3
"""
Arte conceitual do Visual Target (docs/VISUAL_TARGET.md).

Gera as referências pelo worker de imagem da Cloudflare da própria casa
(/root/imagem-worker, Workers AI). Rodar sem argumento regera todas:

    python3 tools/visual-target.py

As imagens caem em packages/client/public/visual-target/ e são publicadas em
https://streampolis.nutef.com/visual-target/ — comprima para .jpg antes de
commitar (os PNGs do flux passam de 500 KB cada).
"""
import base64, json, sys, urllib.request

URL = "https://imagem.contato-66e.workers.dev/v1/images/generations"
# O worker fica atrás da Cloudflare: o User-Agent padrão do urllib toma 403.
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/128.0 Safari/537.36")


def gerar(out, prompt, steps=8, ratio="16:9"):
    req = urllib.request.Request(
        URL,
        data=json.dumps({
            "prompt": prompt,
            "model": "@cf/black-forest-labs/flux-1-schnell",
            "num_inference_steps": steps,
            "ratio": ratio,
        }).encode(),
        headers={
            "content-type": "application/json",
            "authorization": "Bearer 0001",
            "user-agent": UA,
        },
    )
    body = json.load(urllib.request.urlopen(req, timeout=240))
    item = (body.get("data") or [{}])[0]
    b64 = item.get("b64_json") or item.get("image")
    if not b64:
        raise SystemExit(f"sem imagem: {json.dumps(body)[:300]}")
    with open(out, "wb") as fh:
        fh.write(base64.b64decode(b64))
    return out


PROMPTS = {
 "avatar-feminina": "Full body character reference of a stylized 3D female video game character standing in a relaxed neutral pose on a plain light studio background, young woman in her early twenties with warm medium brown skin, long dark wavy hair, large expressive eyes with clearly readable irises, friendly confident face, appealing semi-cartoon proportions with a slightly larger head for readability, clean unbroken silhouette, five separate fingers on each hand, wearing a cropped magenta bomber jacket over a white crop top, high waisted wide leg jeans and chunky white sneakers, small gold hoop earrings, soft three point studio lighting with gentle rim light, subsurface scattering skin, fabric with visible weave and roughness, high end 3D animation studio quality render, cinematic but clean, video game character reference art",
 "avatar-masculino": "Full body character reference of a stylized 3D male video game character standing in a relaxed neutral pose on a plain light studio background, young man in his early twenties with deep brown skin, short cropped black hair with a clean fade, defined jawline, warm friendly readable face with expressive eyes, appealing semi-cartoon proportions with broad shoulders and a clean unbroken silhouette, five separate fingers on each hand, wearing an oversized teal hoodie, black cargo trousers with strap details and cream and orange high top sneakers, soft three point studio lighting with gentle warm rim light, subsurface scattering skin, fabric with visible weave and roughness, high end 3D animation studio quality render, cinematic but clean, video game character reference art",
 "rosto-feminino": "Close up three quarter portrait of a stylized 3D female video game character, young woman in her early twenties with warm medium brown skin, large expressive almond eyes with detailed irises and eyelashes, defined eyebrows, small nose, full lips with a warm smile, soft cheeks, long dark wavy hair framing the face, semi cartoon stylization with appealing readable features, subsurface scattering skin with subtle pore texture, soft studio key light with cool rim light, shallow depth of field, high end 3D animation studio quality render, character face reference for a life simulation video game",
 "rosto-masculino": "Close up three quarter portrait of a stylized 3D male video game character, young man in his early twenties with deep brown skin, short cropped black hair with a clean fade, defined jawline and cheekbones, expressive warm brown eyes with detailed irises, light stubble, calm confident half smile, semi cartoon stylization with appealing readable features, subsurface scattering skin with subtle pore texture, soft studio key light with warm rim light, shallow depth of field, high end 3D animation studio quality render, character face reference for a life simulation video game",
 "praca": "Stylized 3D game environment key art, wide view of a contemporary city plaza in a warm latin american inspired city, a circular stone fountain raised on three broad steps in the centre, curved wooden benches, tall lamp posts, small kiosks, a ring of leafy trees, a large freestanding glowing LED billboard on the far side showing abstract colourful light, colourful low rise facades with balconies closing the horizon, a few stylized young people in casual streetwear crossing the square, late afternoon golden hour sunlight with long soft shadows, semi cartoon stylization with clean simplified shapes and readable silhouettes, controlled warm palette with one magenta accent, soft global illumination, subtle atmospheric haze, high end 3D animation studio quality, cinematic wide composition",
 "apartamento": "Stylized 3D game environment key art, interior of a small cosy studio apartment of a young content creator, three quarter interior view, warm wooden floor, a large window on the left casting a long patch of late afternoon sunlight across the floor, a low blue sofa with cushions and a rug, round coffee table, a bed with a soft duvet in the corner, a streaming corner on the right with a desk, monitor, microphone on a boom arm, a ring light on a stand and a glowing magenta neon sign on the wall, a compact kitchenette with two stools, houseplants, pendant lamps, semi cartoon stylization with clean simplified shapes, cosy inviting mood, controlled palette of warm wood cream and dusty blue with a magenta accent, soft global illumination with warm practical lights, high end 3D animation studio quality",
 "live-room": "Stylized 3D game environment key art, small broadcast studio set for a live streaming show, a large curved LED wall backdrop glowing in magenta and electric blue with abstract audio meter bars, dark acoustic slat walls, a glowing rectangular floor mark outlined in magenta neon, a stylized young woman streamer standing on the mark with her arms open mid gesture, a ring light on a stand, a broadcast camera on a tripod, an overhead lighting truss with three spotlights casting visible soft light cones through faint haze, two speaker stacks, a small purple sofa in the guest corner, dramatic stage lighting with strong colour separation between subject and background, semi cartoon stylization, controlled palette of deep violet magenta and cyan with warm skin tones, high end 3D animation studio quality, cinematic composition",
}


DESTINO = "packages/client/public/visual-target"


if __name__ == "__main__":
    if len(sys.argv) == 3:
        print(gerar(sys.argv[1], sys.argv[2]))
    else:
        import time
        for nome, prompt in PROMPTS.items():
            saida = f"{DESTINO}/{nome}.png"
            for _ in range(3):
                try:
                    gerar(saida, prompt)
                    print("ok", nome)
                    break
                except Exception as erro:  # NSFW falso-positivo acontece
                    print("retry", nome, erro)
                    time.sleep(3)

