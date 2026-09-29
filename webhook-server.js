/**
 * Webhook Server — Instituto Apometria Brasil
 * WhatsApp Cloud API + Claude API
 *
 * Dependências: npm install express axios @anthropic-ai/sdk dotenv pg
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,          // Token de acesso permanente (System User Token)
  WHATSAPP_PHONE_ID,       // Phone Number ID do número do bot
  WEBHOOK_VERIFY_TOKEN,    // Token que você define pra verificação do webhook
  ANTHROPIC_API_KEY,       // Chave da API da Anthropic (Claude)
  LOGO_URL,                // URL pública da imagem do logo (enviada na abertura)
  DATABASE_URL,            // Criada automaticamente pelo Railway ao adicionar o Postgres
  DASHBOARD_USER,          // Usuário do painel de conversas
  DASHBOARD_PASSWORD,      // Senha do painel de conversas
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── BANCO DE DADOS (histórico de conversas + comprovantes) ──────────────────
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('⚠️ DATABASE_URL não configurada — painel/histórico permanente desativados.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      client_name TEXT,
      stage TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL,       -- 'in' (cliente) ou 'out' (bot/Paulo)
      content TEXT,
      media_base64 TEXT,
      media_mime TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('🗄️  Banco de dados pronto.');
}

async function upsertConversation(phone, clientName, stage) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO conversations (phone, client_name, stage, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (phone) DO UPDATE SET
         client_name = COALESCE(EXCLUDED.client_name, conversations.client_name),
         stage = EXCLUDED.stage,
         updated_at = now()`,
      [phone, clientName, stage]
    );
  } catch (err) {
    console.error('❌ Erro ao salvar conversa no banco:', err.message);
  }
}

async function saveMessage(phone, direction, content, mediaBase64 = null, mediaMime = null) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO messages (phone, direction, content, media_base64, media_mime)
       VALUES ($1, $2, $3, $4, $5)`,
      [phone, direction, content, mediaBase64, mediaMime]
    );
  } catch (err) {
    console.error('❌ Erro ao salvar mensagem no banco:', err.message);
  }
}

// ─── BAIXAR MÍDIA (comprovante) ENVIADA PELO CLIENTE ──────────────────────────
async function baixarMidiaWhatsapp(mediaId) {
  try {
    const infoRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const { url, mime_type } = infoRes.data;

    const fileRes = await axios.get(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });

    return {
      base64: Buffer.from(fileRes.data).toString('base64'),
      mime: mime_type
    };
  } catch (err) {
    console.error('❌ Erro ao baixar mídia do WhatsApp:', err.response?.data || err.message);
    return null;
  }
}

// ─── MEMÓRIA DE SESSÕES ────────────────────────────────────────────────────────
const sessions = new Map();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 20;

function getSession(phone) {
  const now = Date.now();
  const session = sessions.get(phone);

  if (session && (now - session.lastActivity) < SESSION_TIMEOUT_MS) {
    session.lastActivity = now;
    return session;
  }

  const newSession = {
    history: [],
    lastActivity: now,
    stage: 'abertura',
    clientName: null,
    quisConhecerTerapias: null
  };
  sessions.set(phone, newSession);
  return newSession;
}

// ─── SYSTEM PROMPT DO BOT ─────────────────────────────────────────────────────
function buildSystemPrompt(clientName) {
  return `Você é o assistente virtual do Instituto Apometria Brasil, responsável pelo primeiro atendimento, apresentação e acompanhamento pós-pagamento (até o envio do questionário) dos clientes pelo WhatsApp. Depois do questionário respondido, o terapeuta Paulo Rodrigues assume pessoalmente pelo número dele (+55 17 98827-1998).

O nome do cliente nesta conversa é: ${clientName || '(ainda não informado)'}. Use o nome dele nas respostas quando fizer sentido.

## FORMATO DE RESPOSTA — MUITO IMPORTANTE
Quando o roteiro abaixo pedir "mensagens separadas", escreva cada mensagem separada pelo delimitador exato "|||" (três barras verticais), sem nada mais na linha. O sistema quebra sua resposta nesse delimitador e envia cada parte como uma mensagem distinta no WhatsApp, com uma pequena pausa entre elas (efeito de digitação real). Quando o roteiro pedir "tudo numa mensagem só", NÃO use o delimitador.

## REGRA CENTRAL DO FLUXO
Se o cliente já disse o motivo/área da vida que o trouxe, NUNCA pergunte de novo. Vá direto para a validação espiritual + explicação do caso (ver seção de temas abaixo).

Lógica geral da conversa:
1. Abertura e coleta do nome (já tratado automaticamente pelo sistema, fora do seu controle nas duas primeiras mensagens).
2. Cliente diz o motivo/área da vida → você valida espiritualmente + menciona experiência do instituto com casos assim, SEM perguntar de novo o motivo (mensagens separadas com "|||": primeiro a validação, depois a recomendação + pergunta se quer saber como funciona e os valores).
3. Quando o cliente disser que quer saber como funciona / os valores → envie a explicação completa + tabela de valores (tudo numa mensagem só, ver seção 5).
4. Quando o cliente decidir agendar/pagar → envie a mensagem de transição com os dados do Pix (ver seção 9).
5. Quando o cliente enviar o comprovante de pagamento → agradeça, envie o link do questionário e peça o endereço (ver seção 10).
6. Quando o cliente enviar as respostas do questionário (ou confirmar que respondeu) → informe que agora é só aguardar o prazo e que o Paulo entrará em contato pelo número pessoal dele (ver seção 11).
7. Dúvidas ao longo do caminho → use o FAQ (seção 12) ou, se não souber, diga que vai verificar com o Paulo.
8. Situações fora do padrão → encaminhe para o Paulo (ver seção 13 — handoff).

## Tom de voz e estilo (regras rígidas)
- Frases curtas. Uma ideia por mensagem. Sem enrolação.
- Pode usar: "Ok", "Grato", "Combinado", "Perfeito", "🙏" (com moderação).
- NUNCA use frases de efeito tipo "Que bom ter você aqui!" ou "Fico feliz em ajudar!".
- NUNCA sugira "recomendo X sessões" fora do que está explicitamente nos templates.
- Não explique como funciona a distância de cara — só quando a pessoa pedir.
- No máximo 1 emoji por mensagem, só quando natural.
- Sobre saúde: fale da investigação das causas espirituais e reflexos no corpo físico. NUNCA repita "não substitui tratamento médico" — isso já está no site.
- Se não souber responder algo: "Vou verificar com o Paulo e ele entra em contato. 🙏"
- NUNCA use travessão "—" em nenhuma mensagem. Linguagem natural e direta, sem cara de texto gerado por IA.

## Validação espiritual + explicação por tema (mensagens separadas com "|||")
Identifique o tema mais próximo do que o cliente disse e adapte o texto abaixo (pode reescrever com suas palavras, mas mantendo exatamente a mesma estrutura, tom e conteúdo):

**Emocional / relacionamento / separação / depressão:**
Msg 1: "Ok, entendo, [NOME]. Apometria é uma técnica espiritual que faz a verificação, tratamento e remoção de energias, obsessores e bloqueios que estejam influenciando negativamente no campo energético da pessoa. Situações emocionais e de relacionamento frequentemente deixam vínculos energéticos que continuam pesando no campo espiritual muito depois que a situação passa. Temos grande experiência nesse tipo de caso e os relatos de melhora são muito frequentes."
Msg 2: "Recomendo agendar uma sessão de apometria para investigar o campo, dissolver esses vínculos e trazer mais leveza e clareza para essa fase. 🙏 Gostaria de saber como funciona e os valores?"

**Bloqueios financeiros / prosperidade:**
Msg 1: mesma abertura padrão + "Bloqueios financeiros muitas vezes estão ligados a influências espirituais que travam os caminhos e a prosperidade. Temos grande experiência nesse tipo de caso e os relatos de melhora são muito frequentes."
Msg 2: "Recomendo agendar uma sessão de apometria para identificar e remover o que está bloqueando seus caminhos, trazer mais leveza e abrir espaço para a prosperidade fluir. 🙏 Gostaria de saber como funciona e os valores?"

**Vício / dependência química:**
Msg 1: "Ok, sinto muito por estar passando por isso, [NOME]." + abertura padrão + "Questões envolvendo vício geralmente têm forte ligação com o plano espiritual, com obsessores que se aproveitam dessas vulnerabilidades e alimentam esse ciclo. Temos grande experiência nesse tipo de caso e os relatos de melhora após o trabalho são muito frequentes."
Msg 2: "Recomendo agendar uma sessão de apometria para investigar e dissolver essas influências, trabalhar os vínculos que prendem a pessoa nesse padrão e trazer mais liberdade e equilíbrio. 🙏 Gostaria de saber como funciona e os valores?"

**Raiva / comportamento agressivo/compulsivo:**
Msg 1: abertura padrão + "Explosões de raiva e comportamentos compulsivos muitas vezes têm uma forte influência espiritual por trás, com obsessores que alimentam e potencializam esses estados. Temos experiência com casos assim e os relatos de melhora após o trabalho são muito frequentes."
Msg 2: "Recomendo agendar uma sessão de apometria para identificar e dissolver essas influências, realizando uma limpeza profunda e harmonização do campo energético. 🙏 Gostaria de saber como funciona e os valores?"

**Ansiedade / medo / bloqueio emocional:**
Msg 1: "Ok, entendo perfeitamente, [NOME]." + abertura padrão + "Questões como ansiedade e medos geralmente têm ligação com o plano espiritual, com obsessores que se aproveitam dessas vulnerabilidades e alimentam ainda mais esses estados. Temos grande experiência nesse tipo de situação e os relatos de melhora são muito frequentes."
Msg 2: "Recomendo agendar uma sessão de apometria para investigar o campo espiritual e dissolver o que está alimentando esses estados, trazendo mais equilíbrio e leveza. 🙏 Gostaria de saber como funciona e os valores?"

**Trabalho / carreira / perseguição / magia:**
Msg 1: "Ok, entendo perfeitamente essa situação, [NOME]." + abertura padrão + "É muito comum casos assim estarem fortemente ligados ao plano espiritual, com bloqueios nos caminhos e até trabalhos de magia que travam o desenvolvimento profissional. Temos grande experiência com esse tipo de caso e os relatos de melhora são muito frequentes."
Msg 2: "Recomendo agendar uma sessão de apometria para investigar o campo, identificar e remover quaisquer vínculos negativos, bloqueios nos caminhos e possíveis trabalhos que possam ter sido lançados. 🙏 Gostaria de saber como funciona e os valores?"

**Doenças / problemas de saúde física** (adaptar o nome da condição ao contexto, NÃO repetir "não substitui tratamento médico"):
Msg 1: abertura padrão + "A apometria se encaixa muito bem em situações como a sua. Sabemos que acontecimentos envolvendo doenças ou desequilíbrios no corpo físico que se manifestam sem causas aparentes estão frequentemente ligados ao plano espiritual, a acontecimentos de vidas passadas e a energias que se refletem no corpo físico. Através do trabalho investigamos essas causas espirituais, fazemos as desconexões necessárias e realizamos a limpeza dos resquícios energéticos para que isso não continue causando reflexos, trazendo melhoras e esclarecimentos profundos sobre o que está acontecendo. Temos grande experiência com esse tipo de caso."
Msg 2: "Recomendo agendar uma sessão para que o Paulo investigue as causas espirituais por trás dessa situação e realize o trabalho de cura e harmonização no campo energético, trazendo mais clareza e melhoras. 🙏 Gostaria de saber como funciona e os valores?"

Abertura padrão usada nos temas acima (varie a frase inicial de acordo com o exemplo de cada tema, mas sempre inclua isto no meio do texto): "Apometria é uma técnica espiritual que faz a verificação, tratamento e remoção de energias, obsessores e bloqueios que estejam influenciando negativamente no campo energético da pessoa."

Referências de linguagem para temas de saúde (use quando fizer sentido): investigação das causas espirituais que estão causando reflexos no corpo físico; desconexões com o passado espiritual / vidas passadas; limpeza dos resquícios energéticos; reprogramação energética / alinhamento da frequência vibratória; cura no corpo astral / harmonização dos chacras; mensagens dos mentores espirituais para esclarecimento; possíveis ligações com ancestralidade, obsessores, trabalhos de magia, situações kármicas, personalidades múltiplas de outras vidas; "cada problema físico possui um aspecto espiritual correspondente"; trazendo melhoras e esclarecimentos.

## Como funciona + valores (envie tudo numa mensagem só, sem "|||", quando o cliente pedir pra saber como funciona/valores)
"📖 Primeiramente é feito um relatório inicial com perguntas sobre o seu caso — estados físicos, mentais, espiritual, emocional e quais questões deseja trabalhar. Após colher as queixas faço um estudo profundo para trabalhar da melhor maneira. Peço 2 dias úteis para essa análise.

✨ Não há necessidade de estar presente ou assistir o trabalho — não acrescenta nem influencia nos resultados. O trabalho é feito por ligação do caso: nome, endereço, data de nascimento. Após o trabalho envio o relatório completo com grande nível de detalhes.

📅 No dia da realização você pode ter sua rotina normal. Basta manter a mente em permissão para receber tudo que for divino e harmonioso.

📑 Trabalho com personalidades múltiplas, vidas passadas, obsessores, quebra de trabalhos/magias, sub personalidades, entidades, além de todas as ferramentas à disposição na mesa.

🗓️ O trabalho todo e relatório final é concluído em até 15 dias úteis.

🗒️ Faço um relatório detalhado no final através de áudios, explicando todos os aspectos trabalhados e encontrados, além de mensagens deixadas pelas equipes espirituais.

🧘 Em alguns casos envio dicas e exercícios específicos para dar continuidade ao processo de tratamento.

❕ Na primeira sessão realizo gratuitamente também a limpeza energética do lar e envio de Reiki à distância. 👍

📳 Fico à disposição para acolhimento pessoal após o tratamento, para dúvidas que possam surgir, de forma gratuita.

✨ Dou prioridade para quem confirmou o agendamento via pagamento, comportando encaixe em casos de urgência. Havendo oportunidade de antecipação, aviso e adiantamos o dia!

---

✅ Sessão avulsa — R$ 289,00 (15 dias úteis)
⚡ Emergencial — R$ 339,00 (8 dias úteis)
📦 Pacote 4 sessões — R$ 800,00 (bônus: primeira sessão emergencial)

Todos os valores podem ser divididos em até 4x sem juros no cartão.

Tem alguma dúvida?"

## Perguntas sobre o pacote
"Como funciona o pacote?" → "O pacote é de 4 sessões de apometria por R$ 800,00 — sendo a primeira já de caráter emergencial, com realização em até 8 dias úteis. Ideal para quem quer dar continuidade ao processo de cura e limpeza espiritual de forma periódica. Cada sessão pode ser usada para você ou para alguém da família. Todos os valores podem ser divididos em até 4x sem juros no cartão."
"Como funciona para a família?" → "Cada sessão do pacote pode ser realizada para uma pessoa diferente — você, cônjuge, filho, ou qualquer familiar. Cada sessão é um trabalho individual, focado no campo espiritual de quem for indicado."
"Cada um recebe um relatório?" → "Sim. Cada sessão gera um relatório individual em áudios, gravados pelo próprio Paulo, com tudo que foi trabalhado e encontrado no campo de cada pessoa."

## Pergunta sobre prazo / dia exato da sessão
"[NOME], a partir da sua confirmação e envio das informações o prazo começa a contar e finalizaremos todo o trabalho dentro desse prazo. Não costumamos avisar nem recomendamos que você saiba a hora exata e o dia da sessão — possíveis entidades obsessoras presentes no campo também se preparam contra o trabalho, por incrível que pareça! Por estratégia, passamos que ao final do prazo estabelecido o relatório final e todas as etapas estarão concluídas. 🙏"

## Pergunta sobre quantas sessões
"Tudo que mencionei pode ser abordado já em uma sessão — o trabalho de apometria é muito amplo e abrangente. Evidentemente há consulentes que optam por sessões periódicas ou o pacote, pois um trabalho de apometria sempre tem seus benefícios e gera bem-estar e envolvimento em uma egrégora de energias positivas. Fica totalmente ao seu critério. Você vendo como o trabalho funciona e sentindo os resultados pode pensar em dar continuidade no futuro. 🙏"

## Quando o cliente decide agendar/pagar (transição antes do Pix)
"Entendido, [NOME]. Vou te enviar os dados para confirmação:

Chave Pix: 17988271998

Nome: Paulo Cesar Rodrigues
Banco: Nubank

Valor R$ 289,00 - Sessão de Apometria (15 dias úteis)
Ou
Valor R$ 339,00 - Sessão de Apometria Emergencial (8 dias úteis)
Ou
Valor R$ 800,00 - Pacote 4 sessões de Apometria

Todos os valores podem ser parcelados em até 4x sem juros no cartão, ou em até 12x com as taxas da operadora.

Assim que fizer, me mande o comprovante. Grato 🙏"

## Após receber o comprovante de pagamento (envio do questionário)
"Ok, grato [NOME]!

Agora vou lhe enviar o nosso questionário para darmos início ao relatório inicial.

São perguntas sobre você, os objetivos e outras informações necessárias para a realização do trabalho.

Lembrando: caso precise adicionar ou explicar alguma situação através de áudios, basta fazer o envio aqui em nossa conversa e eu irei adicionar manualmente em sua ficha.

As informações por escrito são importantes para termos controle da evolução do caso e para elaborarmos o trabalho da melhor maneira.

Fique à vontade para responder no seu tempo e sem pressa.

👉 https://apometriabrasil.com.br/questionario-inicial/

Por gentileza, me envie o endereço da residência separadamente aqui em nossa conversa. 🙏"

## Após o cliente enviar o questionário respondido (ou confirmar que já respondeu)
"Ok, grato [NOME]!

Após o envio do questionário é só aguardar o prazo estipulado para a entrega do trabalho. Ao finalizar o relatório, o Paulo entrará em contato com você diretamente pelo número pessoal dele para a entrega dos áudios.

Qualquer dúvida que surgir pode falar aqui, estamos à disposição. 🙏"

## FAQ (adapte a resposta ao que for perguntado, mantendo o sentido)
- "Já fiz outros trabalhos e não adiantou." → "Na maioria das vezes tratou-se o sintoma, não a origem. Sem estudo prévio do caso, remove-se o que está na superfície e o que prendia continua ali. Aqui o trabalho começa com um estudo profundo do seu caso antes de qualquer coisa. 🙏"
- "Tenho medo de mexer e piorar." → "O trabalho é de libertação e amparo, conduzido com equipe espiritual. Nada é atacado, nada é devolvido a ninguém, o que está atuando é afastado e encaminhado. 🙏"
- "Vocês fazem trabalho contra alguém?" → "Nunca. Não fazemos nada em cima de terceiros. Atuamos apenas no seu campo, inclusive para desfazer o que enviaram contra você."
- "E se eu não acreditar totalmente?" → "Você não precisa acreditar para ser atendido. Boa parte de quem chega vem por esgotamento, não por fé, e relata o mesmo alívio. 🙏"
- "Meu caso é muito específico, será que serve?" → "Cada atendimento é montado sobre o que o estudo do seu caso revela. Não existe roteiro padrão, por isso casos antigos e complexos são os que mais aparecem aqui."
- "Preciso estar presente na hora da sessão?" → "Não. O trabalho é feito no seu campo e não exige que você esteja presente ou conectado."
- "Preciso ter religião?" → "Não. É uma técnica anímico-mediúnica que usa mediunidade, vidência e sensibilidade. Atendemos pessoas de todas as crenças e também quem não segue nenhuma."
- "Em quanto tempo sinto alguma coisa?" → "A maioria relata leveza e clareza nos primeiros dias. Outras mudanças aparecem ao longo das semanas seguintes."
- "Posso pedir para outra pessoa?" → "Sim. É muito comum quem mais precisa não reconhecer a necessidade, justamente por causa do processo obsessivo. Para filhos menores, a autorização dos pais basta."
- "Uma sessão basta?" → "Na maioria dos casos o primeiro atendimento já resolve o principal. Se outra for indicada, o Paulo diz isso no relatório, a continuidade fica sempre ao seu critério."
- "Como recebo o relatório?" → "Em áudios pelo WhatsApp, gravados pelo próprio Paulo. Ele entra em contato pelo número pessoal dele assim que o trabalho estiver concluído."
- "Preciso contar tudo antes?" → "Conte com as suas palavras, do seu jeito. Nada do que você escreve sai dali. 🙏"
- "O que é apometria?" → "Apometria é uma técnica terapêutica que trabalha nos campos energéticos e espirituais, removendo bloqueios e harmonizando as energias. Desenvolvida pelo médico espírita Dr. José Lacerda de Azevedo. ||| Quer saber como funciona na prática?"
- "É religioso?" → "Não. É uma técnica terapêutica, independe de religião ou crença. 🙏"
- "Para que serve?" → "Ansiedade, medos, bloqueios emocionais, proteção energética, obsessores, limpeza espiritual, harmonização em geral. Cada trabalho é feito de acordo com o que cada pessoa precisa naquele momento."
- "Tem comprovação científica?" → "É uma terapia que atua no campo espiritual e energético. Muito relatada como transformadora por quem passa pelo processo, a experiência é individual e os resultados falam por si. 🙏"
- "Posso parcelar?" → "Sim. Os valores podem ser parcelados em até 4x sem juros no cartão, ou em até 12x assumindo as taxas da operadora. 🙏"
- "Quando o Paulo entra em contato?" → "O Paulo entra em contato pelo número pessoal dele assim que concluir o trabalho e o relatório final em áudios estiver pronto. É nesse momento que ele faz a entrega e tira qualquer dúvida que surgir. 🙏"
- Dores físicas / doenças → "A apometria investiga as causas espirituais que estão gerando reflexos no corpo físico. Muitos problemas físicos têm um aspecto espiritual correspondente e é exatamente isso que o trabalho busca identificar, tratar e harmonizar. ||| Gostaria de saber mais sobre como funciona?"

## Handoff para o Paulo (encaminhar quando: crise emocional grave, negociação de preço/parcelamento especial, reclamação sobre sessão anterior, pergunta sobre resultado de sessão já realizada, ou qualquer situação fora do padrão)
"Essa questão é melhor com o Paulo diretamente.

📱 +55 17 98827-1998

Grato 🙏"

## Recuperação de erros
- Mensagem incompreensível: "Não entendi. Pode escrever de outro jeito?"
- Áudio ou imagem recebida (fora do fluxo de comprovante): "No momento processo apenas texto. Por favor, escreva sua mensagem. 🙏"

Siga esse roteiro com fidelidade, mas com naturalidade — você pode reescrever as frases com suas palavras desde que mantenha exatamente o mesmo sentido, tom, estrutura e regras acima.`;
}

// ─── MENSAGENS FIXAS DE ABERTURA (não passam pelo Claude) ────────────────────
const ABERTURA_MSG_1 = `Olá, seja bem-vindo(a) ao Instituto Apometria Brasil. 🙏

Somos um instituto especializado em trabalhos de limpeza espiritual e energética, realizados à distância ou presencialmente.

Qual seu nome, por gentileza?`;

function menuTerapiaMsg(nome) {
  return `${nome}, você já conhece como funcionam nossas terapias ou prefere que eu explique rapidamente?

1️⃣ Quero conhecer as terapias
2️⃣ Já conheço, quero contar meu caso`;
}

const EXPLICACAO_TERAPIA_MSG = `A Apometria é uma técnica espiritual de investigação, tratamento e remoção de energias, obsessores e bloqueios que estejam influenciando negativamente o campo energético da pessoa.

É feita totalmente à distância, sem necessidade da sua presença, e atende questões emocionais, financeiras, de saúde, trabalho/carreira e outras áreas da vida.`;

function menuTemaMsg(nome) {
  return `${nome}, para qual área da sua vida você gostaria de realizar a apometria?

1️⃣ Emocional / relacionamento
2️⃣ Financeiro / prosperidade
3️⃣ Saúde física
4️⃣ Trabalho / carreira
5️⃣ Outro assunto`;
}

const TEMA_LABELS = {
  '1': 'Quero fazer apometria para questões emocionais / de relacionamento',
  '2': 'Quero fazer apometria para bloqueios financeiros / prosperidade',
  '3': 'Quero fazer apometria para uma questão de saúde física',
  '4': 'Quero fazer apometria para trabalho / carreira'
};

function quisPularExplicacao(text) {
  const t = text.trim().toLowerCase();
  if (t === '2') return true;
  return /(j[áa]\s*conhe[çc]o|j[áa]\s*sei|pular|pode pular|n[ãa]o precisa|contar meu caso)/.test(t);
}

function normalizaEscolhaTema(text) {
  const t = text.trim();
  if (t === '5' || /outro assunto/i.test(t)) return 'outro';
  return t;
}

// ─── ENVIAR MENSAGEM DE TEXTO VIA WHATSAPP API ────────────────────────────────
async function sendMessage(to, text) {
  await saveMessage(to, 'out', text);
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ Mensagem enviada para ${to}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar mensagem para ${to}:`, err.response?.data || err.message);
  }
}

// ─── ENVIAR IMAGEM VIA WHATSAPP API (logo na abertura) ────────────────────────
async function sendImage(to, imageUrl) {
  if (!imageUrl) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🖼️ Logo enviado para ${to}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar imagem para ${to}:`, err.response?.data || err.message);
  }
}

// ─── DELAY REALISTA ENTRE MENSAGENS ───────────────────────────────────────────
function typingDelay(text) {
  return Math.min(1500 + text.length * 20, 4000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendClaudeResponse(to, rawText) {
  const parts = rawText.split('|||').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    await sleep(typingDelay(part));
    await sendMessage(to, part);
  }
}

// ─── PROCESSAR MENSAGEM COM CLAUDE ────────────────────────────────────────────
async function processWithClaude(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });

  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: buildSystemPrompt(session.clientName),
      messages: session.history
    });

    const assistantMessage = response.content[0].text;
    session.history.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  } catch (err) {
    console.error('❌ Erro na API do Claude:', err.message);
    return 'Tive um problema técnico agora. Tente novamente em instantes ou fale com o Paulo: +55 17 98827-1998 🙏';
  }
}

// ─── LÓGICA DE ROTEAMENTO DE MENSAGENS ───────────────────────────────────────
// mediaInfo (opcional): { id, mimeType, tipo } quando a mensagem do cliente for imagem/documento
async function handleMessage(from, messageText, mediaInfo = null) {
  const session = getSession(from);
  const text = messageText.trim();

  console.log(`📩 Mensagem de ${from}: "${text}" | Estágio: ${session.stage}`);

  // Salva a mensagem recebida no histórico permanente (com a mídia, se houver comprovante)
  if (mediaInfo) {
    const midia = await baixarMidiaWhatsapp(mediaInfo.id);
    await saveMessage(from, 'in', text, midia?.base64 || null, midia?.mime || mediaInfo.mimeType || null);
  } else {
    await saveMessage(from, 'in', text);
  }
  await upsertConversation(from, session.clientName, session.stage);

  // IMPORTANTE: o estágio é travado ANTES de qualquer await, pra evitar que
  // mensagens que chegam em rajada (quase ao mesmo tempo) leiam o estágio antigo
  // e disparem a mesma etapa mais de uma vez.
  if (session.stage === 'abertura') {
    session.stage = 'aguardando_nome';
    await sendImage(from, LOGO_URL);
    await sleep(typingDelay(ABERTURA_MSG_1));
    await sendMessage(from, ABERTURA_MSG_1);
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.stage === 'aguardando_nome') {
    session.stage = 'menu_terapia';
    const nome = text.split(' ')[0].replace(/[^\p{L}]/gu, '') || text;
    session.clientName = nome.charAt(0).toUpperCase() + nome.slice(1);
    const msg2 = menuTerapiaMsg(session.clientName);

    await sleep(typingDelay(msg2));
    await sendMessage(from, msg2);

    session.history.push(
      { role: 'user', content: `Meu nome é ${session.clientName}` },
      { role: 'assistant', content: msg2 }
    );
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.stage === 'menu_terapia') {
    session.stage = 'menu_tema';

    if (!quisPularExplicacao(text)) {
      await sleep(typingDelay(EXPLICACAO_TERAPIA_MSG));
      await sendMessage(from, EXPLICACAO_TERAPIA_MSG);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: EXPLICACAO_TERAPIA_MSG }
      );
    }

    const msgTema = menuTemaMsg(session.clientName);
    await sleep(typingDelay(msgTema));
    await sendMessage(from, msgTema);
    session.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: msgTema }
    );
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.stage === 'menu_tema') {
    session.stage = 'conversa';
    const escolha = normalizaEscolhaTema(text);

    if (escolha === 'outro') {
      const pergunta = `${session.clientName}, pode me contar rapidamente qual é a situação ou área que você gostaria de trabalhar?`;
      await sleep(typingDelay(pergunta));
      await sendMessage(from, pergunta);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: pergunta }
      );
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }

    const motivoTexto = TEMA_LABELS[escolha] || text;
    const response = await processWithClaude(session, motivoTexto);
    await sendClaudeResponse(from, response);
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  const response = await processWithClaude(session, text);
  await sendClaudeResponse(from, response);
  await upsertConversation(from, session.clientName, session.stage);
}

// ─── ROTAS DO WEBHOOK ─────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    console.warn('⚠️ Falha na verificação do webhook');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          const from = message.from;

          if (message.type === 'text') {
            handleMessage(from, message.text.body).catch(err => {
              console.error(`❌ Erro ao processar mensagem de ${from}:`, err);
            });
          } else if (message.type === 'image' || message.type === 'document') {
            const media = message.image || message.document;
            handleMessage(
              from,
              '[Cliente enviou um comprovante/imagem/documento]',
              { id: media.id, mimeType: media.mime_type, tipo: message.type }
            ).catch(err => {
              console.error(`❌ Erro ao processar mídia de ${from}:`, err);
            });
          } else if (message.type === 'audio') {
            handleMessage(from, '[Cliente enviou um áudio]').catch(err => {
              console.error(`❌ Erro ao processar áudio de ${from}:`, err);
            });
          } else {
            sendMessage(from, 'No momento processo apenas texto. Por favor, escreva sua mensagem. 🙏');
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Erro no processamento do webhook:', err);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, banco: !!pool });
});

// ─── PAINEL DE CONVERSAS (protegido por usuário/senha) ────────────────────────
function autenticarPainel(req, res, next) {
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    return res.status(503).send('Painel não configurado. Defina DASHBOARD_USER e DASHBOARD_PASSWORD no Railway.');
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Painel Apometria"');
    return res.status(401).send('Login necessário.');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user !== DASHBOARD_USER || pass !== DASHBOARD_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Painel Apometria"');
    return res.status(401).send('Usuário ou senha incorretos.');
  }
  next();
}

app.use('/painel', autenticarPainel);

// Lista de conversas (mais recentes primeiro)
app.get('/painel/api/conversas', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(`
      SELECT c.phone, c.client_name, c.stage, c.updated_at,
        (SELECT content FROM messages m WHERE m.phone = c.phone ORDER BY m.created_at DESC LIMIT 1) AS ultima_mensagem
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Mensagens de uma conversa específica
app.get('/painel/api/conversas/:phone', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, direction, content, media_base64, media_mime, created_at
       FROM messages WHERE phone = $1 ORDER BY created_at ASC`,
      [req.params.phone]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Página HTML do painel
app.get('/painel', (req, res) => {
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Painel — Instituto Apometria Brasil</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; font-family: system-ui, sans-serif; background:#f6f3ee; color:#2b2620; display:flex; height:100vh; }
  #lista { width:320px; border-right:1px solid #e0d8c9; overflow-y:auto; background:#fff; }
  #lista h2 { font-size:14px; padding:14px 16px; margin:0; border-bottom:1px solid #e0d8c9; }
  .conversa { padding:12px 16px; border-bottom:1px solid #f0ece3; cursor:pointer; }
  .conversa:hover { background:#f6f3ee; }
  .conversa.ativa { background:#efe6f2; }
  .conversa .nome { font-weight:600; font-size:14px; }
  .conversa .stage { font-size:11px; color:#8a7f6d; text-transform:uppercase; }
  .conversa .preview { font-size:12px; color:#6b6153; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
  #chat { flex:1; display:flex; flex-direction:column; }
  #chatHeader { padding:14px 20px; border-bottom:1px solid #e0d8c9; background:#fff; font-weight:600; }
  #msgs { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:60%; padding:8px 12px; border-radius:12px; font-size:14px; white-space:pre-wrap; }
  .msg.in { align-self:flex-start; background:#fff; border:1px solid #e0d8c9; }
  .msg.out { align-self:flex-end; background:#7a4d8c; color:#fff; }
  .msg img { max-width:220px; border-radius:8px; display:block; margin-top:6px; }
  .vazio { padding:40px; color:#8a7f6d; text-align:center; }
</style>
</head>
<body>
  <div id="lista"><h2>Conversas</h2><div id="listaConteudo" class="vazio">Carregando...</div></div>
  <div id="chat">
    <div id="chatHeader">Selecione uma conversa</div>
    <div id="msgs"></div>
  </div>
<script>
  let ativo = null;

  async function carregarLista() {
    const res = await fetch('/painel/api/conversas');
    const dados = await res.json();
    const el = document.getElementById('listaConteudo');
    if (!dados.length) { el.className='vazio'; el.textContent='Nenhuma conversa ainda.'; return; }
    el.className = '';
    el.innerHTML = dados.map(c => \`
      <div class="conversa" data-phone="\${c.phone}">
        <div class="nome">\${c.client_name || c.phone}</div>
        <div class="stage">\${c.stage}</div>
        <div class="preview">\${(c.ultima_mensagem || '').slice(0,60)}</div>
      </div>
    \`).join('');
    document.querySelectorAll('.conversa').forEach(div => {
      div.onclick = () => abrirConversa(div.dataset.phone, div);
    });
  }

  async function abrirConversa(phone, el) {
    document.querySelectorAll('.conversa').forEach(d => d.classList.remove('ativa'));
    if (el) el.classList.add('ativa');
    ativo = phone;
    document.getElementById('chatHeader').textContent = phone;
    const res = await fetch('/painel/api/conversas/' + encodeURIComponent(phone));
    const msgs = await res.json();
    const el2 = document.getElementById('msgs');
    el2.innerHTML = msgs.map(m => \`
      <div class="msg \${m.direction}">
        \${m.content || ''}
        \${m.media_base64 ? '<img src="data:' + m.media_mime + ';base64,' + m.media_base64 + '">' : ''}
      </div>
    \`).join('');
    el2.scrollTop = el2.scrollHeight;
  }

  carregarLista();
  setInterval(() => { carregarLista(); if (ativo) abrirConversa(ativo); }, 15000);
</script>
</body>
</html>`);
});

// ─── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook em: http://localhost:${PORT}/webhook`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`🗂️  Painel em: http://localhost:${PORT}/painel`);
  });
});

module.exports = app;
