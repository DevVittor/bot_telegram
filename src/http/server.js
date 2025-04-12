import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import "dotenv/config";
import qrcode from "qrcode-terminal";
import { Client, LocalAuth } from "whatsapp-web.js";

// Configurações
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MERCADOPAGO_TOKEN = process.env.MERCADOPAGO_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_URL;
const SEU_CHAT_ID = process.env.SEU_CHAT_ID;
const GRUPO_ID = process.env.GRUPO_ID;
const SEU_WHATSAPP = process.env.ZAP; // Seu número no formato internacional

// Inicialização
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN);
let db;

// Configuração do WhatsApp
const whatsappClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

whatsappClient.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
  console.log("Escaneie o QR Code acima para conectar ao WhatsApp");
});

whatsappClient.on("ready", () => {
  console.log("WhatsApp client está pronto!");
});

whatsappClient.initialize();

// Objeto para armazenar formulários em andamento
const formulariosPendentes = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

// Conexão com MongoDB
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    db = client.db("telegram_bot");
    await db.command({ ping: 1 });
    console.log("Conectado ao MongoDB com sucesso!");
  } catch (err) {
    console.error("Falha na conexão com MongoDB:", err);
    process.exit(1);
  }
}

// Configurar Webhook do Telegram
async function setupWebhook() {
  try {
    const webhookUrl = `${RAILWAY_URL}/telegram-webhook`;
    console.log(`Configurando webhook para: ${webhookUrl}`);
    await bot.setWebHook(webhookUrl);
    console.log("Webhook configurado com sucesso!");
  } catch (err) {
    console.error("Erro ao configurar webhook:", err);
    throw err;
  }
}

// Função para enviar mensagem ao WhatsApp
async function enviarParaWhatsApp(mensagem) {
  try {
    const chatId = `${SEU_WHATSAPP}@c.us`;
    await whatsappClient.sendMessage(chatId, mensagem);
    console.log("Mensagem enviada para WhatsApp com sucesso");
  } catch (error) {
    console.error("Erro ao enviar para WhatsApp:", error);
  }
}

// Funções auxiliares
async function verificarAssinatura(userId) {
  try {
    const user = await db.collection("users").findOne({ user_id: userId });
    return user && user.status === "active";
  } catch (err) {
    console.error("Erro ao verificar assinatura:", err);
    return false;
  }
}

async function criarLinkPagamento(userId, dadosFormulario) {
  try {
    const response = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      {
        items: [
          {
            title: "Assinatura Mensal",
            quantity: 1,
            unit_price: 29.9,
            currency_id: "BRL",
          },
        ],
        back_urls: {
          success: `${RAILWAY_URL}/sucesso`,
          failure: `${RAILWAY_URL}/erro`,
          pending: `${RAILWAY_URL}/pendente`,
        },
        notification_url: `${RAILWAY_URL}/mp-webhook`,
        metadata: {
          telegram_user_id: userId,
          nome: dadosFormulario.nome,
          email: dadosFormulario.email,
          telefone: dadosFormulario.telefone,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.init_point || response.data.sandbox_init_point;
  } catch (error) {
    console.error("Erro ao criar link de pagamento:", error);
    throw error;
  }
}

// Função para enviar formulário
async function enviarFormulario(chatId) {
  return new Promise(async (resolve, reject) => {
    if (formulariosPendentes.has(chatId)) {
      await bot.sendMessage(
        chatId,
        "ℹ️ Você já tem um formulário em andamento."
      );
      return reject(new Error("Formulário já em andamento"));
    }

    const formulario = {
      etapa: 1,
      dados: {},
      listener: null,
    };

    formulariosPendentes.set(chatId, formulario);

    const timeout = setTimeout(() => {
      if (formulario.listener) {
        bot.removeListener("message", formulario.listener);
      }
      formulariosPendentes.delete(chatId);
      bot.sendMessage(chatId, "⌛ Tempo expirado. Use /start para recomeçar.");
      reject(new Error("Tempo expirado"));
    }, 600000);

    formulario.listener = async (msg) => {
      if (msg.chat.id !== chatId || msg.text.startsWith("/")) return;

      try {
        const formularioAtual = formulariosPendentes.get(chatId);
        if (!formularioAtual) return;

        switch (formularioAtual.etapa) {
          case 1:
            formularioAtual.dados.nome = msg.text;
            formularioAtual.etapa = 2;
            await bot.sendMessage(chatId, "2. Qual seu e-mail?");
            break;

          case 2:
            if (!msg.text.includes("@")) {
              await bot.sendMessage(
                chatId,
                "❌ Por favor, digite um e-mail válido:"
              );
              return;
            }
            formularioAtual.dados.email = msg.text;
            formularioAtual.etapa = 3;
            await bot.sendMessage(chatId, "3. Qual seu telefone com DDD?");
            break;

          case 3:
            formularioAtual.dados.telefone = msg.text;

            // Salva no banco de dados
            await db.collection("formularios").insertOne({
              user_id: chatId,
              ...formularioAtual.dados,
              data_preenchimento: new Date(),
            });

            // Limpa o estado
            clearTimeout(timeout);
            bot.removeListener("message", formularioAtual.listener);
            formulariosPendentes.delete(chatId);
            resolve(formularioAtual.dados);
            break;
        }
      } catch (error) {
        clearTimeout(timeout);
        if (formulario.listener) {
          bot.removeListener("message", formulario.listener);
        }
        formulariosPendentes.delete(chatId);
        reject(error);
      }
    };

    bot.on("message", formulario.listener);

    try {
      await bot.sendMessage(chatId, "📝 Precisamos de algumas informações:");
      await bot.sendMessage(chatId, "1. Qual seu nome completo?");
    } catch (error) {
      clearTimeout(timeout);
      if (formulario.listener) {
        bot.removeListener("message", formulario.listener);
      }
      formulariosPendentes.delete(chatId);
      reject(error);
    }
  });
}

// Rotas
app.post("/telegram-webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/mp-webhook", async (req, res) => {
  try {
    const paymentId = req.body.data?.id;
    if (!paymentId) {
      return res.status(400).json({ error: "ID de pagamento ausente" });
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MERCADOPAGO_TOKEN}` } }
    );

    const { metadata, status } = response.data;
    const userId = metadata?.telegram_user_id;

    if (userId && status === "approved") {
      // Atualiza o banco de dados
      await db.collection("users").updateOne(
        { user_id: userId },
        {
          $set: {
            mp_subscription_id: paymentId,
            status: "active",
            updated_at: new Date(),
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      // Envia para o WhatsApp
      const mensagemWhatsApp =
        `✅ NOVO ASSINANTE\n\n` +
        `Nome: ${metadata.nome}\n` +
        `Email: ${metadata.email}\n` +
        `Telefone: ${metadata.telefone}\n` +
        `ID Telegram: ${userId}\n` +
        `ID Pagamento: ${paymentId}`;

      await enviarParaWhatsApp(mensagemWhatsApp);

      // Notifica o usuário
      await bot.sendMessage(
        userId,
        "🎉 Pagamento aprovado! Você será adicionado ao grupo em instantes."
      );

      // Adiciona ao grupo
      try {
        await bot.addChatMember(GRUPO_ID, userId);
        await bot.sendMessage(
          GRUPO_ID,
          `👋 Bem-vindo ${metadata.nome || "novo membro"} ao grupo!`
        );
      } catch (error) {
        console.error("Erro ao adicionar ao grupo:", error);
        const inviteLink = await bot.createChatInviteLink(GRUPO_ID, {
          member_limit: 1,
        });

        await bot.sendMessage(
          userId,
          `🔗 Aqui está seu link para o grupo: ${inviteLink.invite_link}`
        );
      }
    }

    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Handlers do Telegram
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const isAssinante = await verificarAssinatura(chatId);

    if (isAssinante) {
      await bot.sendMessage(
        chatId,
        "✅ Você já é um assinante ativo! Acesso liberado."
      );
      return;
    }

    try {
      await bot.sendMessage(
        chatId,
        "Vamos precisar de algumas informações antes de gerar seu link de pagamento..."
      );

      const dadosFormulario = await enviarFormulario(chatId);
      const linkPagamento = await criarLinkPagamento(chatId, dadosFormulario);

      await bot.sendMessage(
        chatId,
        `🔗 Aqui está seu link de pagamento:\n${linkPagamento}\n\n` +
          `Após o pagamento, você será adicionado automaticamente ao grupo.`
      );
    } catch (error) {
      console.error("Erro no formulário:", error);
      await bot.sendMessage(
        chatId,
        "⚠️ Ocorreu um erro. Por favor, comece novamente com /start."
      );
    }
  } catch (error) {
    console.error("Erro no comando /start:", error);
    await bot.sendMessage(
      chatId,
      "⚠️ Ocorreu um erro. Tente novamente mais tarde."
    );
  }
});

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    timestamp: new Date(),
    formularios_ativos: formulariosPendentes.size,
  });
});

// Inicialização
async function startServer() {
  try {
    console.log("Iniciando servidor...");

    if (
      !TELEGRAM_TOKEN ||
      !MERCADOPAGO_TOKEN ||
      !MONGODB_URI ||
      !SEU_CHAT_ID ||
      !GRUPO_ID
    ) {
      throw new Error("Variáveis de ambiente faltando!");
    }

    await connectDB();
    await setupWebhook();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🔗 Webhook: ${RAILWAY_URL}/telegram-webhook`);
      console.log(`🔗 MercadoPago Webhook: ${RAILWAY_URL}/mp-webhook`);
    });
  } catch (err) {
    console.error("Falha na inicialização:", err);
    process.exit(1);
  }
}

startServer();
