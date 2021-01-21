

require('dotenv').config()
const fs = require('fs')
const express = require('express')
const http = require('http')
const moment = require('moment-timezone')
const numeral = require('numeral')
const Web3 = require('web3')
const BN = require('bignumber.js')
const _ = require('lodash')
const HDWalletProvider = require('@truffle/hdwallet-provider')
const inputs = require('./YD-ETH-MAR21-inputs.js')
const approve = require('./approve.js')
const jsonData = require('./tokenData.json')
const approvalStatus = require('./approvalStatus.json')

// SERVER CONFIG
const PORT = process.env.PORT || 5000
const app = express()
const server = http.createServer(app).listen(PORT, () => console.log(`Listening on ${ PORT }`))

// WEB 3 CONFIG
const web3 = new Web3(new HDWalletProvider(process.env.PRIVATE_KEY, process.env.RPC_URL))
web3.eth.transactionConfirmationBlocks = 1;

/***** CONTRACT DETAILS for Balancer Pool ****/
const contractData = jsonData['Balancer USDC-YD-ETH-MAR21']
const contract = new web3.eth.Contract(contractData.abi, contractData.address)
contract.transactionConfirmationBlocks = 1;

/***** CONTRACT for Target Token *****/
// decimals = 18; use ether
const targetTokenData = jsonData['YD-ETH-MAR21']
const targetToken = new web3.eth.Contract(targetTokenData.abi, targetTokenData.address)

/***** CONTRACT for USDC *****/
// decimals = 6; use mwei
const baseTokenData = jsonData['USDC']
const baseToken = new web3.eth.Contract(baseTokenData.abi, baseTokenData.address)

/***** USER INPUTS *****/
var approval = 0
const baseTokenApproved = web3.utils.toWei(inputs.baseTokenApproved, 'mwei') // 1000 base token converted to wei
const maxTrade = web3.utils.toWei(inputs.maxTrade, 'mwei') // 100 base token converted to wei
const weight = web3.utils.toWei(inputs.weightRatio, 'ether') // convers weightRatio to value in wei
const targetTokenValue = inputs.targetTokenValue * (10 ** 6) // converts target value to BigNumber

  //////////////////////////////////////////////////////////////////////////////
 //  FUNCTIONS                                                               //
//////////////////////////////////////////////////////////////////////////////

async function walletBalance() {
    try {
        let balance
        // Check balance of USDC
        balance = await baseToken.methods.balanceOf(inputs.baseTokenAccount).call()
        balance = web3.utils.fromWei(balance.toString(), 'mwei')
        console.log('USDC Balance in Wallet: ', balance)
        // Check balance of synthetic
        balance = await targetToken.methods.balanceOf(inputs.baseTokenAccount).call()
        balance = web3.utils.fromWei(balance.toString(), 'ether')
        console.log('Synth Balance in Wallet: ', balance)
    } catch (error) {
        console.error(`Could not get balance: ${error}`)
    }
}


/* async function approveToken(tokenInstance, receiver, amount) {
    try {
        let approval = await tokenInstance.methods.approve(receiver, amount).send({ from: inputs.baseTokenAccount })
        console.log(`ERC20 token approved: tx/${approval.transactionHash}`)
        return amount

    } catch (error) {
        console.log('ERC20 could not be approved')
        console.error(`Error approving token: ${error}`)
    }   
} */

async function usdcForSynthExchange() {
    try {        
        /***** current pool status *****/
        baseTokenBalance = await contract.methods.getBalance(baseTokenData.address).call()
        targetTokenBalance = await contract.methods.getBalance(targetTokenData.address).call()
        targetSpotPrice = await contract.methods.getSpotPrice(baseTokenData.address, targetTokenData.address).call()
        poolFee = await contract.methods.getSwapFee().call()
        
        /***** max amount we can trade based on impact to spot price *****/
        inGivenPrice = baseTokenBalance.toString() * (((targetTokenValue / targetSpotPrice.toString()) ** inputs.weightRatio) - 1)
        inGivenPrice = Math.floor(inGivenPrice)
        tradeSize = Math.min(inGivenPrice, maxTrade)
        
        /***** slippage *****/
        outGivenIn = await contract.methods.calcOutGivenIn(baseTokenBalance, weight, targetTokenBalance, weight, tradeSize.toString(), poolFee).call()
        minSynthOut = web3.utils.toBN(outGivenIn.toString() * 0.99) // 1% acceptable slippage
        maxPrice = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
        console.log('Min Synths to be Received: ', minSynthOut.toString())

        /***** gas limit and price *****/
        var gasLimit = await contract.methods.swapExactAmountIn(baseTokenData.address, tradeSize.toString(), targetTokenData.address, minSynthOut.toString(), maxPrice).estimateGas({from: inputs.baseTokenAccount})
        var gasPrice = await web3.eth.getGasPrice()
        gasPrice = web3.utils.toBN(gasPrice * 1.10) // will pay 10% above current avg. gas prices to expedite transaction
        
        /***** setting inputs for transaction *****/
        const SETTINGS = {
            gasLimit: gasLimit,
            gasPrice: gasPrice,
            from: inputs.baseTokenAccount,
            transactionConfirmationBlocks: 1
        }
        
        console.log('Gas Price Set: ', web3.utils.fromWei(gasPrice.toString(), 'gwei'))
        console.log('Trade Size: ', web3.utils.fromWei(tradeSize.toString(), 'mwei'), 'USDC for approx:', web3.utils.fromWei(outGivenIn.toString(), 'ether'), 'target tokens')
        
        console.log('Performing swap...')
        let result = await contract.methods.swapExactAmountIn(baseTokenData.address, tradeSize.toString(), targetTokenData.address, minSynthOut.toString(), maxPrice).send(SETTINGS)
        console.log('Swap Successful! tx/', result.transactionHash)

    } catch (error) {
        console.error(error)
        return
    }
}

let priceMonitor
let monitoringPrice = false

async function monitorPrice() {
    if (monitoringPrice) {
        return
    }

    approvedAmount = approvalStatus['approvedAmount']
    if (approvedAmount < maxTrade) {
        approvedAmount = await approve.approveToken(baseToken, contractData.address, baseTokenApproved, inputs.baseTokenAccount)
        console.log('Additional USDC Approved: ', approvedAmount)
    }
    approvedAmount = approvedAmount - maxTrade
    fs.writeFileSync('./approvalStatus.json', JSON.stringify(approvedAmount, null, 2) , 'utf-8');

    console.log('Checking price...')
    monitoringPrice = true

    try {
        synthSpotPrice = await contract.methods.getSpotPrice(baseTokenData.address, targetTokenData.address).call()
        price = web3.utils.fromWei(synthSpotPrice.toString(), 'mwei')
        console.log('Current Price: ', price, 'USDC')

        let currentPrice = Number(price)
        let targetPrice = Number(inputs.targetTokenLimit)
        if(currentPrice < targetPrice) {
            console.log('Buying synth...')
            
            await walletBalance()

            await usdcForSynthExchange()

            await walletBalance()

            //clearInterval(priceMonitor)
        }

    } catch (error) {
        console.error(error)
        monitoringPrice = false
        clearInterval(priceMonitor)
        return
    }
    monitoringPrice = false
}

// Checks pool every n seconds
const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 5000 // 5 Seconds
priceMonitor = setInterval(async () => { await monitorPrice() }, POLLING_INTERVAL)
