// P1-02 (SEC-SSRF) — classificação de IP usada por safeImageFetch.
//
// Cobre o defeito confirmado: IPv4-mapped IPv6 em forma HEXADECIMAL
// (::ffff:7f00:1) atravessava a validação anterior e alcançava loopback.
// Também cobre as demais famílias de endereço não globalmente roteáveis e os
// formatos alternativos de IPv4 aceitos por parsers.

import test from "node:test";
import assert from "node:assert/strict";

import { isPrivateIpLiteral } from "../../base44/shared/safeImageFetch.ts";

const BLOCKED = [
  // IPv4 privado / reservado / metadata
  "127.0.0.1",
  "127.1.2.3",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.254",
  "192.168.0.1",
  "169.254.169.254",
  "0.0.0.0",
  "100.64.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "239.255.255.250",
  "255.255.255.255",
  // IPv4 em formatos alternativos
  "2130706433",
  "0x7f000001",
  "0X7F000001",
  "017700000001",
  // IPv6 loopback / não especificado
  "::",
  "::1",
  "[::1]",
  // IPv4-mapped IPv6 — forma pontuada E hexadecimal (o defeito do P1-02)
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:10.0.0.1",
  "::ffff:0a00:1",
  "::ffff:169.254.169.254",
  "::ffff:0:0",
  "0:0:0:0:0:ffff:7f00:1",
  // IPv4-compatível
  "::127.0.0.1",
  "::7f00:1",
  // NAT64 e 6to4 com IPv4 embutido privado
  "64:ff9b::7f00:1",
  "64:ff9b::127.0.0.1",
  "2002:7f00:1::",
  "2002:0a00:1::",
  // Teredo
  "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
  // ULA / link-local / site-local / multicast / reservado
  "fc00::1",
  "fd12:3456:789a::1",
  "fe80::1",
  "fe80::1%eth0",
  "fec0::1",
  "ff02::1",
  "100::1",
  "2001:db8::1",
  "2001:2::1",
  // Malformado
  "::ffff:999.1.1.1",
  "::::1",
  "fe80::1::2",
  "not-an-ip",
  "",
];

const ALLOWED = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "104.21.12.34",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a03:2880:f12f:83:face:b00c:0:25de",
  "::ffff:8.8.8.8",
  "::ffff:0808:0808",
  "2002:0808:0808::",
];

test("P1-02 — bloqueia todos os formatos não globalmente roteáveis", () => {
  for (const ip of BLOCKED) {
    assert.equal(isPrivateIpLiteral(ip), true, `deveria bloquear: ${ip}`);
  }
});

test("P1-02 — não bloqueia endereços públicos legítimos", () => {
  for (const ip of ALLOWED) {
    assert.equal(isPrivateIpLiteral(ip), false, `deveria permitir: ${ip}`);
  }
});

test("P1-02 — IPv4-mapped em hexadecimal é equivalente ao IPv4 embutido", () => {
  // A forma hexadecimal e a pontuada do MESMO endereço têm de classificar igual.
  const pairs = [
    ["::ffff:7f00:1", "127.0.0.1"],
    ["::ffff:0a00:1", "10.0.0.1"],
    ["::ffff:c0a8:0001", "192.168.0.1"],
    ["::ffff:a9fe:a9fe", "169.254.169.254"],
    ["::ffff:0808:0808", "8.8.8.8"],
  ];
  for (const [hex, dotted] of pairs) {
    assert.equal(
      isPrivateIpLiteral(hex),
      isPrivateIpLiteral(dotted),
      `${hex} e ${dotted} deveriam ter a mesma classificação`,
    );
  }
});

test("P1-02 — IPv6 compacto e expandido do mesmo endereço classificam igual", () => {
  const pairs = [
    ["::1", "0:0:0:0:0:0:0:1"],
    ["fc00::1", "fc00:0000:0000:0000:0000:0000:0000:0001"],
    ["2606:4700:4700::1111", "2606:4700:4700:0000:0000:0000:0000:1111"],
  ];
  for (const [compact, expanded] of pairs) {
    assert.equal(
      isPrivateIpLiteral(compact),
      isPrivateIpLiteral(expanded),
      `${compact} e ${expanded} deveriam ter a mesma classificação`,
    );
  }
});