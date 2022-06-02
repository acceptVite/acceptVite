const viteJS = require('@vite/vitejs')
const { HTTP_RPC } = require('@vite/vitejs-http')

const BigNumber = require('bignumber.js')
const lmdb = require('lmdb')

const config = require('./config.json')
const { WebServer, request } = require('./src/web')
const { PaymentHandler } = require('./src/network')

const nodeApi = new viteJS.ViteAPI(new HTTP_RPC(config.vite.nodeAddress))

const db = lmdb.open({ path: 'storage/db.lmdb' })
const paymentDb = db.openDB('payments')
const nodeDb = db.openDB('node')

const wallet = viteJS.wallet.getWallet(config.paymentWallet.mnemonics).deriveAddress(0)

const waitingPayments = nodeDb.get('waitingPayments') ?? new Map()

const webServer = new WebServer(config.server.port)
const paymentHandler = new PaymentHandler(nodeApi, wallet)

webServer.on('request', async (env, res) => {
  if (env.endpoint === 'createPayment') {
    if (!env.params.amount || !BigNumber(env.params.amount).times('1e18').isGreaterThanOrEqualTo('1')) return res.end(JSON.stringify({ err: 'INVALID_AMOUNT' }))

    const generatePaymentID = () => {
      let randomNumber = Math.floor(1000000 + Math.random() * 9000000)

      if (paymentDb.get(randomNumber)) return generatePaymentID()
      return randomNumber.toString()
    }

    const paymentId = generatePaymentID()
    
    await paymentDb.put(paymentId, {
      timestamp: Date.now(),
      amount: BigNumber(env.params.amount).times('1e18').toString(),
      tokenId: env.params.tokenId ?? viteJS.constant.Vite_TokenId,
      data: env.params.data ?? 'NOT_SET',
      callbackAddress: config.gateway.allowExternalCallbacks ? env.params.callbackAddress ?? config.gateway.defaultCallbackUrl : config.gateway.defaultCallbackUrl,
      status: "PENDING"
    })

    waitingPayments.set(paymentId, BigNumber(config.gateway.payTimeout).times('1000'))

    res.end(JSON.stringify({
      walletAddress: wallet.address,
      paymentId: paymentId,
      timeLeft: BigNumber(config.gateway.payTimeout).times('1000')
    }))
  } else if (env.endpoint === 'getPaymentStatus') {
    if (!env.params.paymentId || !paymentDb.get(env.params.paymentId)) return res.end(JSON.stringify({ err: 'INVALID_PAYMENTID' }))

    res.end(JSON.stringify({
      timeLeft: waitingPayments.get(env.params.paymentId),
      status: paymentDb.get(env.params.paymentId).status
    }))
  } else {
    res.end(JSON.stringify({ err: 'INVALID_ENDPOINT' }))
  }
})

paymentHandler.on('confirmed', async (payment) => {
  let cache = paymentDb.get(payment.paymentId)

  cache.status = 'COMPLETED'

  await paymentDb.put(payment.paymentId, cache)

  request(cache.callbackAddress, {
    timestamp: cache.timestamp,
    amount: cache.amount,
    tokenId: cache.tokenId,
    data: cache.data ?? 'NOT_SET',
    status: cache.status
  })
})

paymentHandler.on('discovered', async (payment) => {
  if (!paymentDb.get(payment.paymentId)) return

  if (waitingPayments.has(payment.paymentId)) {
    waitingPayments.delete(payment.paymentId)

    let cache = paymentDb.get(payment.paymentId)

    if (!payment.tokenId === cache.tokenId || !payment.amount === cache.amount) return
    paymentHandler.whitelistBlock(payment.hash)

    cache.status = 'WAITING_CONFIRM'

    await paymentDb.put(payment.paymentId, cache)
  }
})

setInterval(() => {
  waitingPayments.forEach((value, key) => {
    if (BigNumber(value).isLessThanOrEqualTo("0")) {
      return waitingPayments.delete(key)
    }

    waitingPayments.set(key, BigNumber(value).minus('100').toString())
  })
}, 100)


process.stdin.resume()

process.on('SIGINT', async () => {
  await nodeDb.put('waitingPayments', waitingPayments)
  console.log(nodeDb.get('waitingPayments'))
})
