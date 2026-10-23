import { describe, expect, it } from 'vitest'
import { buildResponse, decodeQuestion } from './dev-dns.mjs'

const DOMAIN = 'local.example.test'

function encodeQuery(name, qtype = 1, { id = 0x1234, qclass = 1, rd = true } = {}) {
  const labels = name.split('.').filter(Boolean)
  const question = []
  for (const label of labels)
    question.push(Buffer.from([label.length]), Buffer.from(label, 'latin1'))
  question.push(Buffer.from([0]))

  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(qtype, 0)
  tail.writeUInt16BE(qclass, 2)

  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(rd ? 0x0100 : 0, 2)
  header.writeUInt16BE(1, 4)

  return Buffer.concat([header, ...question, tail])
}

function parseHeader(res) {
  return {
    id: res.readUInt16BE(0),
    flags: res.readUInt16BE(2),
    rcode: res.readUInt16BE(2) & 0xf,
    qdcount: res.readUInt16BE(4),
    ancount: res.readUInt16BE(6),
    nscount: res.readUInt16BE(8),
    arcount: res.readUInt16BE(10),
  }
}

describe('decodeQuestion', () => {
  it('解析单个 question', () => {
    const q = decodeQuestion(encodeQuery(`foo.${DOMAIN}`, 1, { id: 0xabcd, qclass: 1 }))
    expect(q).toMatchObject({
      id: 0xabcd,
      name: `foo.${DOMAIN}`,
      qtype: 1,
      qclass: 1,
    })
  })

  it('丢弃短包、响应包、多 question 和非法标签', () => {
    expect(decodeQuestion(Buffer.alloc(4))).toBeNull()

    const response = encodeQuery(`foo.${DOMAIN}`)
    response.writeUInt16BE(response.readUInt16BE(2) | 0x8000, 2)
    expect(decodeQuestion(response)).toBeNull()

    const multi = encodeQuery(`foo.${DOMAIN}`)
    multi.writeUInt16BE(2, 4)
    expect(decodeQuestion(multi)).toBeNull()

    const truncated = encodeQuery(`foo.${DOMAIN}`).subarray(0, 14)
    expect(decodeQuestion(truncated)).toBeNull()
  })
})

describe('buildResponse', () => {
  it('子域名 A 查询返回 127.0.0.1', () => {
    const query = encodeQuery(`foo.${DOMAIN}`)
    const res = buildResponse(query, { domain: DOMAIN })
    const header = parseHeader(res)

    expect(header).toMatchObject({
      id: 0x1234,
      rcode: 0,
      qdcount: 1,
      ancount: 1,
      nscount: 0,
      arcount: 0,
    })
    expect(header.flags & 0x8000).toBe(0x8000) // QR
    expect(header.flags & 0x0400).toBe(0x0400) // AA

    const answerOffset = decodeQuestion(query).questionEnd
    expect(res.readUInt16BE(answerOffset)).toBe(0xc00c)
    expect(res.readUInt16BE(answerOffset + 2)).toBe(1) // TYPE A
    expect(res.readUInt16BE(answerOffset + 4)).toBe(1) // CLASS IN
    expect(res.readUInt32BE(answerOffset + 6)).toBe(60) // TTL
    expect(res.readUInt16BE(answerOffset + 10)).toBe(4) // RDLENGTH
    expect([...res.subarray(answerOffset + 12, answerOffset + 16)]).toEqual([127, 0, 0, 1])
  })

  it('根域名也匹配', () => {
    const res = buildResponse(encodeQuery(DOMAIN), { domain: DOMAIN })
    expect(parseHeader(res)).toMatchObject({ rcode: 0, ancount: 1 })
  })

  it('AAAA 返回 NOERROR 且没有回答，让浏览器回落 IPv4', () => {
    const res = buildResponse(encodeQuery(`foo.${DOMAIN}`, 28), { domain: DOMAIN })
    expect(parseHeader(res)).toMatchObject({ rcode: 0, ancount: 0 })
  })

  it('非目标域名返回 NXDOMAIN', () => {
    const res = buildResponse(encodeQuery('example.com'), { domain: DOMAIN })
    expect(parseHeader(res)).toMatchObject({ rcode: 3, ancount: 0 })
  })

  it('非 IN class 不返回记录', () => {
    const res = buildResponse(encodeQuery(`foo.${DOMAIN}`, 1, { qclass: 3 }), { domain: DOMAIN })
    expect(parseHeader(res)).toMatchObject({ rcode: 3, ancount: 0 })
  })

  it('原样回显 question，保留 0x20 大小写', () => {
    const query = encodeQuery(`FoO.${DOMAIN}`)
    const res = buildResponse(query, { domain: DOMAIN })
    const questionEnd = decodeQuestion(query).questionEnd
    expect(res.subarray(12, questionEnd)).toEqual(query.subarray(12, questionEnd))
  })

  it('非法报文返回 null', () => {
    expect(buildResponse(Buffer.alloc(4), { domain: DOMAIN })).toBeNull()
  })
})