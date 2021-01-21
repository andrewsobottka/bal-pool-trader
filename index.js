

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
        console.log(baseTokenData.symbol, 'balance in Wallet: ', balance)
        // Check balance of synthetic
        balance = await targetToken.methods.balanceOf(inputs.baseTokenAccount).call()
        balance = web3.utils.fromWei(balance.toString(), 'ether')
        console.log(targetTokenData.symbol, 'balance in Wallet: ', balance)
    } catch (error) {
        console.error(`Could not get balance: ${error}`)
    }
}

async function tokenExchange() {
    try {        
        /***** Pull current pool variables for subsequent calculations *****/
        baseTokenBalance = await contract.methods.getBalance(baseTokenData.address).call()
        targetTokenBalance = await contract.methods.getBalance(targetTokenData.address).call()
        targetSpotPrice = await contract.methods.getSpotPrice(baseTokenData.address, targetTokenData.address).call()
        poolFee = await contract.methods.getSwapFee().call()
        
        /***** Calculate max amount we can trade based on impact to spot price *****/
        inGivenPrice = baseTokenBalance.toString() * (((targetTokenValue / targetSpotPrice.toString()) ** inputs.weightRatio) - 1)
        inGivenPrice = Math.floor(inGivenPrice)
        tradeSize = Math.min(inGivenPrice, maxTrade)
        
        /***** Set slippage *****/
        outGivenIn = await contract.methods.calcOutGivenIn(baseTokenBalance, weight, targetTokenBalance, weight, tradeSize.toString(), poolFee).call()
        minSynthOut = web3.utils.toBN(outGivenIn.toString() * 0.99) // 1% acceptable slippage
        maxPrice = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
        //console.log('Min Synths to be Received: ', minSynthOut.toString())

        /***** Estimate gas limit and price *****/
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
        
        //console.log('Gas Price Set: ', web3.utils.fromWei(gasPrice.toString(), 'gwei'))
        console.log('Trading: ', web3.utils.fromWei(tradeSize.toString(), 'mwei'), 'USDC for approx:', web3.utils.fromWei(outGivenIn.toString(), 'ether'), 'target tokens')
        
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
    
    console.log('--- Refreshing ---')

    /***** ERC20 Token Approval *****/
    /* The current amt of tokens approved to trade is stored in the approvalStatus.json
        file and referenced here. When the current amount approved is estimated below
        the max trade size, an additional approval request will be submitted. The amt
        approved will be maintained evevn after program is terminated. */
    approvalStatus = JSON.parse(fs.readFileSync('approvalStatus.json'))
    currApprovedAmount = approvalStatus.approvedAmount
    //console.log('Amount already approved: ', currApprovedAmount.toString())
    
    if (currApprovedAmount <= maxTrade) {
        currApprovedAmount = await approve.approveToken(baseToken, contractData.address, baseTokenApproved, inputs.baseTokenAccount)
        console.log('Additional USDC Approved: ', currApprovedAmount)
        var newApprovedAmount = { approvedAmount: currApprovedAmount}
        fs.writeFileSync('./approvalStatus.json', JSON.stringify(newApprovedAmount, null, 2) , 'utf-8');
    }

    /***** Swap *****/
    console.log('Checking price...')
    monitoringPrice = true

    try {
        /***** Checking Price *****/
        /* Swap is only performed if current Spot Price is below the target price. */
        synthSpotPrice = await contract.methods.getSpotPrice(baseTokenData.address, targetTokenData.address).call()
        price = web3.utils.fromWei(synthSpotPrice.toString(), 'mwei')
        console.log('Current Price: 1', targetTokenData.symbol, 'for', price, 'USDC')
        let currentPrice = Number(price)
        let targetPrice = Number(inputs.targetTokenLimit)
        if(currentPrice < targetPrice) {
            console.log(`Price is below target of ${targetPrice.toString()}!`,'Executing Swap...')

            await tokenExchange()

            await walletBalance()

            /***** Update Approval Counter *****/
            /* Approval is reduced by maxTrade size, regardless of actual trade size 
                and written to the approvalStatus.json file so that the running approval
                amount will be maintained after program termination. */
            currApprovedAmount = currApprovedAmount - maxTrade
            var newApprovedAmount = { approvedAmount: currApprovedAmount}
            fs.writeFileSync('./approvalStatus.json', JSON.stringify(newApprovedAmount, null, 2) , 'utf-8');

            console.log('--- Swap Complete ---')
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
const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 4000 // 4 Seconds
priceMonitor = setInterval(async () => { await monitorPrice() }, POLLING_INTERVAL)
