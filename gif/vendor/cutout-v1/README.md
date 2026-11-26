# 누끼(배경 지우기) 도구

카드뉴스 "신상스포" 템플릿에서 상품 사진의 배경을 지울 때 쓴다. 사진은 서버로 보내지 않고 브라우저 안에서 처리한다.
파일을 바꿀 때는 이 폴더를 고치지 말고 새 폴더(cutout-v2 …)를 만들 것 — 브라우저가 이 폴더의 파일을 오래 보관한다.

| 파일 | 출처 | 라이선스 |
| --- | --- | --- |
| `ort.webgpu.min.js`, `ort-wasm-simd-threaded.asyncify.*` | [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.31.1 | MIT (Microsoft) |
| `isnet-w16.0~2.bin` | IS-Net general use ([xuebinqin/DIS](https://github.com/xuebinqin/DIS)), ONNX 변환본 [BritishWerewolf/IS-Net](https://huggingface.co/BritishWerewolf/IS-Net) (원본 변환: [rembg](https://github.com/danielgatis/rembg)) | Apache-2.0 |

`isnet-w16.*.bin` 은 원본 `model.onnx`(178MB)의 가중치만 16비트로 저장해 절반 크기로 줄이고(계산은 32비트 그대로, 결과 차이 0.001 미만),
보조 출력을 뺀 뒤 3조각으로 나눈 것이다. 세 조각을 차례로 이어 붙이면 ONNX 파일 하나가 된다
(sha256 `c43def429e6a8dd6cbe9987e0b47dfad7fdd454f1468b0d11e7833648ba48552`).
