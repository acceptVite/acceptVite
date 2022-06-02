const { accountBlock } = require('@vite/vitejs')
const BigNumber = require('bignumber.js')

const { EventEmitter } = require('events')

class BlockQueuer {
  constructor (viteApi) {
    this.working = false
    this.blockQueue = []

    this.api = viteApi
  }

  queueBlock (block) {
    block.promise = new Promise((resolve, reject) => {
      block._promise = {
        _resolve: resolve,
        _reject: reject
      }
    })

    this.blockQueue.push(block)
    this._process()

    return block.promise
  }

  async _process () {
    if (this.working || this.blockQueue.length === 0) return
    this.working = true

    const processingBlock = this.blockQueue.shift()

    const [ quota, difficulty ] = await Promise.all([
        this.api.request("contract_getQuotaByAccount", processingBlock.address),
        processingBlock.autoSetPreviousAccountBlock()
        .then(() => this.api.request("ledger_getPoWDifficulty", {
            address: processingBlock.address,
            previousHash: processingBlock.previousHash,
            blockType: processingBlock.blockType,
            toAddress: processingBlock.toAddress,
            data: processingBlock.data
        }))
    ])

    const availableQuota = new BigNumber(quota.currentQuota)
    if (availableQuota.isLessThan(difficulty.requiredQuota)) {
        await processingBlock.PoW(difficulty.difficulty)
    }

    await processingBlock.sign().send().catch(err => {
      processingBlock._promise._reject(err.error)
    })

    processingBlock._promise._resolve()

    this.working = false
    this._process()
  }
}

class PaymentHandler extends EventEmitter {
  constructor(viteApi, wallet) {
    super()

    this.blockService = new BlockQueuer(viteApi)
    this.whitelistedBlocks = new Set()

    const handlePayments = async () => {
      const paymentBlocks = await viteApi.request("ledger_getUnreceivedBlocksByAddress", wallet.address, 0, 100).catch(async () => {
        await new Promise(resolve => setTimeout(resolve, 10 * 1000))
        handlePayments() 
        return
      })
      
      for (const block of paymentBlocks) {
        if (BigInt(block.confirmations) >= BigInt("20")) {
          if (this.whitelistedBlocks.has(block.hash)) {
            const receiveBlock = accountBlock.createAccountBlock('receive', {
              address: wallet.address,
              sendBlockHash: block.hash
            }).setProvider(viteApi).setPrivateKey(wallet.privateKey)
    
            await this.blockService.queueBlock(receiveBlock)
            
            this.emit('confirmed', {
              hash: block.hash,
              walletAddress: block.address,
              paymentId: Buffer.from(block.data, 'base64').toString(),
              tokenId: block.tokenInfo.tokenId,
              amount: block.amount
            })  
          }
        } else {
          this.emit('discovered', {
            hash: block.hash,
            walletAddress: block.address,
            paymentId: Buffer.from(block.data, 'base64').toString(),
            tokenId: block.tokenInfo.tokenId,
            amount: block.amount
          })
        }
      }

      await new Promise(resolve => setTimeout(resolve, 10 * 1000))
      handlePayments()
    }

    handlePayments()

  }

  whitelistBlock (hash) {
    this.whitelistedBlocks.add(hash)
  }
}

module.exports = { PaymentHandler }