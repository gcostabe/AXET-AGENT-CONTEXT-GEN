# Relatório Técnico-Funcional Multimodal — REEF/TRON
## Introdução à plataforma, capacidades, modularidade, parametrização e módulo de Comuns

> **Base de evidências.** Este relatório utiliza exclusivamente a transcrição Whisper e os Frames 01–10 recebidos na solicitação. Informações legíveis nos frames ou afirmadas pelos participantes são tratadas como fatos; reorganizações didáticas são contexto; deduções aparecem identificadas como **Análise**.
>
> **Filtro visual.** O Frame 02 é uma tela de videoconferência e foi ignorado, exceto pela identificação contextual de participação técnica, sem descrever pessoas ou controles. O Frame 03 é uma área de trabalho com atalhos e também foi descartado para fins funcionais. O Frame 01 e os Frames 04–10 trazem evidência documental/técnica.
>
> **Confiabilidade da transcrição.** O Whisper contém deformações fonéticas. Quando a documentação visual permite, foi adotada a grafia exibida: **TRON**, **TRON21**, **TronWeb/WebTronWeb**, **NewTron**, **REEF**, **Comunes**, **Terceros**, **Emisión**, **Siniestros**, **Tesorería** e **Contabilidad**. O áudio registra “Neutron”; pelo contexto e pela tabela visual, refere-se a **NewTron**.

## 1. Síntese executiva

A sessão é uma capacitação introdutória sobre **TRON**, apresentado como solução integral de gestão de seguros usada para gerir o ciclo de vida completo das apólices: contratação, cotação, emissão/suscrição, cobrança de recibos, sinistros e, conforme a configuração e o país, contabilização.

O foco não é aprofundar telas operacionais, mas estabelecer um modelo mental comum: TRON é uma plataforma corporativa, viva, modular e altamente parametrizável; é orientada a produtos de seguros, mas mantém identificação centralizada de pessoas físicas e jurídicas e opera por múltiplos canais, moedas, idiomas, companhias e países.

A documentação REEF exibida sustenta a evolução histórica de Tronador (1989) até NewTron (2017), sua presença internacional e as características corporativas, operativas, de produto e de cliente. [Evidência Visual: Frame 04 @ 14:34; Frame 05 @ 18:11; Frames 06–10]

A mensagem executiva da sessão é que a solução deve ser explorada por configuração consistente, e não ser confundida com CRM, BPM ou gestor documental. Integrações com o ecossistema REEF complementam o núcleo de seguros; novos países entram em **NewTron**, enquanto versões anteriores precisam planejar evolução/migração.

## 2. Contexto e antecedentes

A aula começa no portal de documentação REEF, identificado como `pre.marketplace.mapfre.com`, com o componente “documentación reef”, owner `map-capacitacion` e lifecycle `wip`. A árvore visível inclui `01 TRON` e `02 ARQUITECTURA`. [Evidência Visual: Frame 01 @ 03:42]

Segundo a linha do tempo apresentada, a trajetória declarada é:

- **1989 — Tronador:** adaptação do sistema de procedência argentina;
- **1993 — Tron2000:** reengenharia, redesenho e evolução funcional;
- **2002 — TronWeb / WebTronWeb:** frontal Java/HTML;
- **2007 — TRON21:** adaptação de back-end para MAPFRE Espanha;
- **2017 — NewTron:** nova reengenharia, redesenho e evolução funcional. [Evidência Visual: Frame 04 @ 14:34]

A fala contextualiza que Tronador surgiu na Argentina no fim dos anos 1980, que Tron2000 representou evolução sobre a versão argentina e que, em 2002, a mudança para TronWeb alterou majoritariamente o frontal. O Whisper registra termos técnicos pouco nítidos entre “Java”, “Forms 3.0”, “Oracle” e “HTML”; apenas a evidência visual confirma com segurança “Frontal Java / Html”.

TRON21 é explicado como adaptação do back-end e do modelo/banco de dados para suportar MAPFRE Espanha e suas múltiplas entidades seguradoras da época. NewTron é apresentado verbalmente como presente e futuro da aplicação, com mudanças de arquitetura, sem que a arquitetura interna seja especificada.

A presença internacional exibida registra implantações desde Argentina, passando por Espanha, México, Peru, Chile, Puerto Rico, Venezuela, Portugal, Colômbia, Paraguai, República Dominicana, Estados Unidos, Costa Rica, Uruguai, Nicarágua, Guatemala, Honduras, El Salvador e Panamá. Filipinas é marcada como país que já não usa o sistema por estar fora do Grupo MAPFRE. [Evidência Visual: Frame 05 @ 18:11]

## 3. Problemas e necessidades identificados

### 3.1. Conciliar necessidades locais com uma plataforma corporativa

**Problema.** A operação de seguros varia por país: legislação, moedas, dimensão de mercado, processos e práticas locais não são homogêneos.

**Impacto.** Uma solução sem capacidade de adaptação não atenderia países de escalas e contextos distintos, mencionados na fala como Espanha, Brasil, países centro-americanos, Chile, Malta e Turquia.

**Necessidade.** A plataforma precisa aproveitar conhecimento dos países e evoluir funcionalmente sem abandonar a vocação corporativa. A evidência sustenta evolução baseada em solicitações e avaliações de sentido corporativo; não mostra o processo formal de aprovação.

### 3.2. Controlar complexidade de configuração

**Problema.** A solução é descrita como fácil de usar, mas complexa de configurar.

**Impacto.** Configuração inadequada pode comprometer emissão, sinistros, tesouraria e demais resultados operacionais; a fala ressalta que o sistema funciona corretamente quando está bem configurado.

**Necessidade.** Conhecimento especializado para parametrizar produtos, processos, acessos, moedas, estruturas, numerações e regras de negócio.

### 3.3. Garantir coerência transversal entre módulos

**Problema.** Conceitos corporativos — por exemplo, a moeda da companhia — não podem ter significados divergentes por módulo.

**Impacto.** Divergências prejudicariam consistência de cálculo, recebimento, liquidação, tesouraria e contabilização.

**Necessidade.** O módulo de Comunes concentra parâmetros transversais para que módulos consumidores usem definições coerentes.

### 3.4. Delimitar responsabilidades do núcleo

**Problema.** Há expectativa de que uma plataforma de seguros execute funções que pertencem a outras especialidades.

**Impacto.** A fala alerta que TRON não deve ser tratado como CRM, BPM ou gestor documental.

**Necessidade.** Usar integrações para complementar o núcleo, preservando o foco em seguros: emissão, subscrição, cobrança, sinistros, tesouraria e contabilidade quando aplicável.

### 3.5. Evitar manutenção dispersa em versões antigas

**Problema.** Manter funcionalidades em múltiplas versões e muitos países amplia a carga de sustentação.

**Impacto.** O facilitador afirma que algumas funcionalidades deixam de ser entregues em versões anteriores a NewTron e são direcionadas a NewTron em diante.

**Necessidade.** Países em versões anteriores precisam planejar migração/evolução para a versão atual. A sessão não apresenta plano, custo ou cronograma de migração.

## 4. Solução apresentada: visão conceitual

TRON é apresentado como plataforma integral de seguros “por e para MAPFRE”, consolidada no tempo e em múltiplas geografias. Seu núcleo funcional suporta o ciclo de vida de apólice, do processo de contratação até a gestão de prêmios, sinistros e processos econômicos associados.

O modelo mental transmitido combina cinco princípios:

1. **Núcleo de seguros especializado:** emitir e subscrever apólices, cobrar recibos, gerir sinistros e, em cenários aplicáveis, contabilizar.
2. **Modularidade integrada:** funções são agrupadas em módulos, mas compartilham informações de apólices, sinistros e recibos em tempo real, segundo a documentação.
3. **Parametrização governada:** valores configuráveis mudam comportamento, interface, classificação, regras e numerações.
4. **Orientação a produto:** seguros e seus processos são o centro da solução; produtos, coberturas, prêmios e tarefas de sinistro podem ser configurados.
5. **Complementação por integrações:** o que não pertence ao núcleo pode ser atendido por soluções integradas ao ecossistema REEF.

A documentação afirma que a solução é corporativa, moderna/atual, escalável e capaz de atender países diversos. [Evidência Visual: Frame 06 @ 21:48] Essas qualificações são declarações da própria capacitação, não métricas independentes de desempenho.

**Análise:** a solução apresentada privilegia padronização de capacidades de seguros com adaptação por parâmetros e configuração local. A sessão não permite afirmar se o produto é monolítico, distribuído, baseado em serviços ou composto por microserviços.

## 5. Arquitetura e funcionamento: reconstrução lógica

A reconstrução abaixo é **funcional**, sustentada pelas falas e telas. Não deve ser interpretada como topologia física, rede, banco, API, mensageria ou diagrama de implantação.

```text
Canais de comercialização e operação
telefone | web | agentes | mediadores | banca-seguros
                         │
                         ▼
                 TRON — núcleo de seguros
                         │
 ┌───────────────────────┼────────────────────────────────┐
 ▼                       ▼                                ▼
Comunes              Terceros                        Emisión / Suscripción
parâmetros            pessoas e papéis                produtos, cotação, apólices
transversais                 │                                │
 └───────────────────────────┼────────────────────────────────┘
                             ▼
           Siniestros ── Tesorería ── Contabilidad
           expedientes    cobranças/  processos econômicos
                          pagamentos
                             │
                             ▼
     Informações compartilhadas de apólices, sinistros e recibos
                             │
                             ▼
              Integrações com soluções do marketplace REEF
              (tecnologia e interfaces não detalhadas)
```

O módulo de **Comunes** reúne configuração transversal. **Terceros** identifica pessoas físicas e jurídicas, como segurados, agentes, corretores, oficinas, advogados, bancos, peritos e empregados. **Emisión/Suscripción** administra contratação e gestão de apólices. **Siniestros** trata sinistros e prestações. **Tesorería** concentra gestão financeira de cobranças e pagamentos. **Contabilidad** trata contabilização, embora a fala ressalte que determinados países usam SAP para essa função. [Evidência Visual: Frame 10 @ 36:17]

A extensibilidade explicitamente demonstrada é por parâmetros, constantes, listas de valores, estruturas e regras de negócio/controles técnicos. A fala também diz que, quando a funcionalidade de caixa não atende, entidades podem configurar e personalizar código; porém, não informa linguagem, pacotes, sinônimos, procedures, hooks, repositório nem política de extensão.

## 6. Componentes e conceitos mencionados

### 6.1. REEF

Portal/ecossistema de documentação e soluções mencionado como plataforma de integração. O menu visível inclui Componentes, APIs, Arquitetura de Referência, Serviços Cloud, Docs, Zeus e Reef. A expansão da sigla não é fornecida. [Evidência Visual: Frame 01 @ 03:42]

### 6.2. TRON

Solução integral de gestão de seguros. A finalidade declarada é gerir o ciclo de vida completo de apólices. A sessão a posiciona como núcleo de seguros, não CRM, BPM ou gestor documental.

### 6.3. Tronador

Denominação de 1989, adaptada de sistema de procedência argentina. [Evidência Visual: Frame 04 @ 14:34]

### 6.4. Tron2000

Denominação de 1993 ligada a reengenharia, redesenho e evolução funcional. [Evidência Visual: Frame 04 @ 14:34]

### 6.5. TronWeb / WebTronWeb

Denominação de 2002, associada no quadro a frontal Java/HTML. A fala sugere uso majoritário em Turquia por questões específicas de país e afirma obsolescência “como tal”; esse estado não tem data ou critério técnico demonstrado.

### 6.6. TRON21

Adaptação de back-end para MAPFRE Espanha, datada de 2007 na documentação. A fala vincula-a ao atendimento de diversas entidades seguradoras espanholas. [Evidência Visual: Frame 04 @ 14:34]

### 6.7. NewTron

Versão de 2017 descrita como reengenharia, redesenho e evolução funcional. A fala registra “Neutron”, referindo-se contextualmente a NewTron. É apresentada como versão atual/futura e destino de novas integrações de países.

### 6.8. Comunes

Módulo de configuração transversal: conceitos definidos nele podem ser usados por Emisión, Siniestros, Tesorería e Contabilidad. Principais conceitos citados: idiomas, moedas, usuários/roles e estruturas de informação.

### 6.9. Terceros

Módulo de cadastro/gestão de pessoas físicas e jurídicas relacionadas à solução: seguradoras, brokers, agentes, peritos, empregados, bancos, oficinas e advogados, entre outros exemplos.

### 6.10. Emisión / Suscripción

Módulo de contratação e gestão de apólices. Também recebe configurações de produto, regras, controles técnicos, numeração e informações do emissor/intermediário.

### 6.11. Siniestros

Módulo de gestão de sinistros e prestações. A fala cita uso de moedas para liquidações e de parâmetros/estruturas compartilhadas.

### 6.12. Tesorería

Módulo de gestão financeira de cobranças e pagamentos. Moedas, câmbios e estrutura comercial influenciam operações descritas.

### 6.13. Contabilidad e SAP

Contabilidad realiza ação de contabilizar dentro da solução quando usada. A fala diz que a diretriz corporativa aposta em SAP e que, onde SAP executa a contabilização, dados podem proceder do mundo TRON. Não há arquitetura de integração exibida.

### 6.14. IQRF

Sigla citada para funcionalidade de registrar e apoiar gestão/seguimento de incidências, reclamações, queixas ou felicitações de clientes. A expansão não é fornecida.

## 7. Especificação funcional das telas e interfaces (OCR & Evidências Visuais)

### 7.1. Filtro de ruído visual

- **Frame 02 @ 07:19:** videoconferência; ignorado conforme requisito.
- **Frame 03 @ 10:56:** desktop com atalhos corporativos; ignorado como inventário de aplicações, pois não demonstra uma tela funcional compartilhada.

### 7.2. Portal de Documentação REEF

| Elemento observado | Conteúdo visível |
|---|---|
| Sistema/página | Portal de Documentação REEF (`pre.marketplace.mapfre.com`) |
| Componente | `documentación reef` |
| Owner | `map-capacitacion` |
| Lifecycle | `wip` |
| Árvore | Home; `01 TRON`; `02 ARQUITECTURA` |
| Navegação | Buscar, Inicio, Componentes, APIs, Arq. de Referencia, Servicios Cloud, Docs, Crear..., Zeus, Reef |
| Busca | `Search documentación reef docs` |

[Evidência Visual: Frame 01 @ 03:42]

### 7.3. Tela documental: introdução e evolução de versões

| Campo/coluna | Valor observado |
|---|---|
| Página | `Documentación TRON > 01 TRON > 03-Introduccion > INTRODUCCION-TRON` |
| Seção | `Evolución Versiones` |
| 1989 | Tronador — adaptação do sistema de procedência Argentina |
| 1993 | Tron2000 — reengenharia, redesenho e evolução funcional |
| 2002 | TronWeb / WebTronWeb — frontal Java / Html |
| 2007 | TRON21 — adaptação back-end para MAPFRE España |
| 2017 | NewTron — reengenharia, redesenho e evolução funcional |
| Índice lateral | Objetivo; Evolución Versiones; Presencia Internacional; Características Principales; Solución Modular; Flexibilidad; Integraciones MarketPlace REEF |

[Evidência Visual: Frame 04 @ 14:34]

### 7.4. Tela documental: presença internacional

| Período | Países/menções visíveis |
|---|---|
| ...–1990 | Argentina |
| 1990–2000 | España (Mutral-Reale Mutua), México, Perú, España (Mutua Valenciana de Taxis), Chile, Puerto Rico, Venezuela, Portugal, Colombia |
| 2000–2010 | Paraguay, República Dominicana, U.S.A.; España (MAPFRE Tron21) |
| 2010–2020 | Costa Rica, Uruguay, Nicaragua, Guatemala, Filipinas, Honduras, El Salvador |
| 2020–Atual | Panamá |
| Nota | Filipinas já não usa o sistema por estar fora do Grupo MAPFRE |

[Evidência Visual: Frame 05 @ 18:11]

### 7.5. Características e regras observadas

| Categoria | Conteúdo funcional visível |
|---|---|
| Corporativa | Implementada por e para MAPFRE; aproveita conhecimento dos países; provada/consolidada; moderna/atual; escalável. |
| Operativa | Fácil de usar; eficiente; confiável; ciclo de apólice ponta a ponta; multi-companhia; multi-país; multi-moeda; multi-idioma. |
| Produto | Centrada no produto; define/configura produtos e processos; suporta Vida/Não Vida, individual/coletivo; produtos pré-configurados. |
| Cliente | Identificação única; gestão centralizada; classificação de pessoas por atividades; omnicanalidade; reforço para coletivos e fornecedores. |
| Segurança funcional | Informação mostrada segundo acessos e roles atribuídos a usuários. |

[Evidência Visual: Frames 06–09]

### 7.6. Modularidade e flexibilidade

| Elemento | Regra/documentação observável |
|---|---|
| Tesorería | Gestão financeira de cobranças e pagamentos. |
| Contabilidad | Ação/efeito de contabilizar. |
| Integração modular | Módulos compartilham em tempo real informação de apólices, sinistros e recibos. |
| Parâmetros | Valores configurados manualmente que afetam o comportamento do sistema. |
| Possibilidades | Controlar módulos/processos/interface; configurar elementos; representar e definir regras de negócio. |

[Evidência Visual: Frame 10 @ 36:17]

Não foram exibidos formulários operacionais, tipos de campo, máscaras, botões de gravação, mensagens de erro ou validações de tela. O conteúdo visual é documentação, não execução transacional.

## 8. Modelo de integração

A sessão apresenta integração no nível funcional, sem protocolos, endpoints, payloads, eventos, filas, arquivos batch ou assincronia demonstrados.

1. **Entre módulos TRON:** a documentação declara compartilhamento em tempo real de informações de apólices, sinistros e recibos. [Evidência Visual: Frame 10 @ 36:17]
2. **Com módulos consumidores:** Comunes disponibiliza idiomas, moedas, usuários/roles e estruturas para os demais módulos.
3. **Com REEF:** TRON pode integrar-se às soluções propostas pela plataforma REEF, consumidas por sistemas locais ou pela própria plataforma, segundo a fala.
4. **Com SAP:** é citado como solução corporativa de contabilização em alguns países, recebendo dados originados no mundo TRON. Não há prova de API, banco compartilhado, arquivo ou middleware.
5. **Com Banco Central:** o facilitador menciona, somente como hipótese de análise futura, a possibilidade de chamada a API de banco central para alimentar câmbios. Ele explicitamente diz não saber se isso é feito; portanto, não deve ser tratado como integração existente.

**Análise:** o modelo indica interoperabilidade como necessidade de negócio, mas não permite concluir que haja API Gateway, REST, mensageria, replicação ou catálogo técnico de integrações.

## 9. Modelo operacional

### 9.1. Configuração antes da operação

A operação exige parametrização de conceitos corporativos e locais. A sessão cita:

- produtos, processos, coberturas, cálculo de prêmios e tarefas de sinistros;
- idiomas e textos/literais;
- moedas e tipos de câmbio;
- usuários nominais, roles e limites de atuação;
- estruturas geográfica, comercial, de produtos e de canais;
- numeração de apólices, orçamentos, sinistros, ordens de pagamento e cheques;
- constantes e listas de valores;
- controles técnicos/regras de negócio.

Exemplos declarados incluem pedir acessórios na emissão de automóvel, restringir contratação de certos veículos, impedir seguro saúde para menores de 18 anos e definir horário padrão de início de vigência. São exemplos didáticos, não regras corporativas universais.

### 9.2. Dados compartilhados em tempo real

A documentação declara que módulos compartilham em tempo real dados de apólices, sinistros e recibos. Isso sustenta um requisito funcional de integração; não esclarece persistência, replicação, transação, latência nem compartilhamento entre países.

A sessão não aborda monitoramento, incidentes, suporte, release management, hotfixes, observabilidade ou operação de infraestrutura.

## 10. Governança, versionamento e evolução

### 10.1. Procedimentos corporativos mencionados

A documentação REEF funciona como repositório de capacitação. O apresentador orienta participantes a consultar o portal, formular perguntas e acompanhar sessões futuras mais detalhadas.

A evolução da plataforma é descrita como avaliação de mudanças solicitadas pelos países para verificar se fazem sentido corporativamente e atendem aos países usuários. O critério é afirmado, mas não há workflow, comitê, documentação normativa ou responsáveis apresentados.

### 10.2. Evolutivos e mudanças no núcleo

A fala afirma que, no modelo conhecido até então, entidades podem configurar processos/produtos e personalizar código caso a funcionalidade de caixa não cubra necessidades específicas. A introdução de REEF pode modificar esse comportamento; a formulação é prospectiva e não detalha a mudança.

Novas funcionalidades são direcionadas a NewTron em diante. Países em versões anteriores devem planejar migração/evolução, sem decisão de data ou mecanismo apresentada.

### 10.3. Estado de versões

A tabela documental informa as denominações e anos 1989, 1993, 2002, 2007 e 2017. [Evidência Visual: Frame 04 @ 14:34]

Não são informadas versões semânticas, patches, matriz de compatibilidade, suporte de cada país, ciclo de vida formal, política de release ou estado técnico atual de TronWeb/TRON21.

## 11. Organização das equipes e responsabilidades

A sessão identifica, de modo funcional, algumas responsabilidades:

- áreas de negócio definem necessidades e regras locais de seguro;
- pessoas responsáveis pela configuração precisam conhecer profundamente implicações dos parâmetros;
- direção/gerência comercial define a organização comercial e fontes de produção;
- áreas técnicas/atuariais decidem regras de aceitação, como os exemplos de automóvel e saúde;
- equipe corporativa avalia se evolutivos fazem sentido para o conjunto de países;
- participantes são convidados a consultar documentação e levantar dúvidas.

Não há organograma, RACI, Product Manager, Product Owner, Scrum Master, arquiteto, equipe de suporte, papéis de desenvolvimento ou separação formal entre matriz e países exibidos.

## 12. Modelo de produto

### 12.1. Produtos pré-configurados citados

A documentação afirma possibilidade de produtos pré-configurados para uso pelos países. [Evidência Visual: Frame 08 @ 29:02] Não apresenta lista, componentes, coberturas ou disponibilidade de produtos de fábrica.

Exemplos verbais de contexto incluem automóveis, saúde, lar, comércio, viagens, vida risco, vida poupança, acidentes, mercadorias, pequenas/médias empresas e grandes empresas. Eles demonstram amplitude pretendida, não catálogo confirmado.

### 12.2. Direção de padronização

A plataforma é orientada ao produto: permite definir/configurar produtos e processos, regras de negócio, cálculo de prêmios e tarefas de sinistros. A fala reforça uso de parametrização, evitando depender exclusivamente de desenvolvimento.

**Análise:** produtos pré-configurados e parâmetros sugerem reaproveitamento entre países; a sessão não mostra mecanismo de distribuição, governança de templates ou compatibilidade regulatória por produto.

## 13. Terceiros, atividades e modelo de dados

### 13.1. Papel do módulo de terceiros

Terceros mantém pessoas físicas e jurídicas que se relacionam com a seguradora: companhia, broker, agente, perito, empregado, oficina, advogado, banco e segurado, conforme exemplos falados. O módulo é mencionado como local de configuração e gestão dessas figuras.

### 13.2. Atividades e papéis

A fala explica que pessoas são classificadas por atividades: agente, segurado, fornecedor, advogado e outras. Essas classificações seriam aprofundadas em sessão posterior do módulo de Terceiros.

### 13.3. Incompatibilidades e regras de validação

Não há matriz de incompatibilidades entre atividades, nem validações de cadastro demonstradas. A sessão só indica que os parâmetros da instalação podem ativar, desativar ou modificar fluxos de captura no módulo.

### 13.4. Proteção de dados e consentimentos

A reunião não explica LGPD, GDPR/RGPD, consentimento, retenção, anonimização, classificação sensível, autenticação ou criptografia. Portanto, não é possível concluir suporte de privacidade além dos controles de acesso e roles mencionados.

## 14. Produtos, tarifas, impostos e regras locais

### 14.1. Tarifação e impostos

TRON suporta cálculo de prêmios dentro da definição/configuração de produtos, segundo a documentação. A fala menciona tipos de câmbio e unidade de valor financeiro, incluindo UDI no México e UF no Chile, como exemplos de configuração monetária.

Não são exibidas fórmulas de tarifa, alíquotas, impostos, tributos, reservas atuariais, bases de cálculo ou regras fiscais específicas.

### 14.2. Gerador de produtos

A solução dispõe de capacidade de definir/configurar produtos e processos por parametrização. O exemplo apresentado é seguro todo risco de automóveis, com regras de negócio, cálculo de prêmios e tarefas de sinistros/prestações. [Evidência Visual: Frame 08 @ 29:02]

Não são mostradas telas de gerador, entidades de modelo de produto, versionamento ou publicação.

### 14.3. Rating e motores de cálculo

Não há referência a DUP, RT ou motor externo de rating. O cálculo de prêmio é citado como capacidade da solução, porém a tecnologia e os algoritmos não são detalhados.

## 15. Sinistros, documentos e notificações

### 15.1. Documentos e faturas

A sessão menciona documentos de apólice e condições particulares somente como exemplo de idioma de impressão. Não há evidência de geração, template, assinatura, certificado, fatura ou recibo eletrônico.

### 15.2. Notificações

Não são apresentados e-mail, SMS, cartas, push, filas de notificação ou eventos disparadores. A omnicanalidade descrita se refere à contratação de apólices por telefone, web, agentes e banca-seguros.

### 15.3. Limitação de formatos corporativos

Não são apresentados formatos corporativos de documentos nem diferenças locais de layout. Idiomas de caixa explicitamente mencionados: espanhol e inglês. [Evidência Visual: Frame 07 @ 25:25]

## 16. Cosseguro e resseguro

Cosseguro e resseguro não são detalhados. A única menção próxima é que há módulos/processos de seguros e que a plataforma pode configurar ampla gama de produtos.

Não há evidência sobre Re21, cessões, retenções, tratados, contratos proporcionais/não proporcionais, cálculos de resseguro ou integrações operacionais associadas.

## 17. Casos concretos mencionados

### 17.1. Espanha — TRON21 e múltiplas entidades

**Cenário.** A documentação associa TRON21 a MAPFRE Espanha desde 2007. A fala explica que havia várias entidades seguradoras, não apenas uma entidade espanhola única.

**Arquitetura adotada.** Adaptação de back-end/modelo de dados é citada verbalmente; a arquitetura técnica não é demonstrada.

**Particularidade.** Contexto de múltiplas entidades seguradoras.

**Situação/lição.** O caso ilustra necessidade de adaptação de plataforma para estrutura corporativa local.

### 17.2. Puerto Rico — multi-companhia

**Cenário.** A fala cita Puerto Rico como exemplo de utilização multi-companhia desde o início, com três companhias na mesma plataforma.

**Arquitetura adotada.** Configuração por companhia; não há detalhes de separação de dados, tenancy ou acesso.

**Particularidade.** Podem coexistir companhias de Vida e Não Vida.

**Situação/lição.** Multi-companhia é capacidade da plataforma, mas não é obrigatoriamente usada por todos os países.

### 17.3. Panamá — nova integração

**Cenário.** A documentação registra Panamá em “2020 - Actual”; a fala menciona início de operações naquele ano da capacitação.

**Arquitetura adotada.** Em resposta a pergunta, o facilitador afirma que Panamá, ao integrar TRON “agora”, entra em NewTron.

**Particularidade.** Novos países devem usar a versão atual, segundo a resposta.

**Situação/lição.** Versões anteriores precisam projetar migração/evolução para NewTron.

### 17.4. Filipinas — saída do grupo

**Cenário.** A tabela informa que Filipinas já não utiliza o sistema por estar fora do Grupo MAPFRE. [Evidência Visual: Frame 05 @ 18:11]

**Situação/lição.** A presença internacional histórica não equivale necessariamente a uso atual.

### 17.5. Turquia — TronWeb

**Cenário.** A fala afirma que TronWeb era manejado majoritariamente na Turquia por questões concretas do país.

**Limitação de evidência.** Não foram explicadas as questões, a data de uso, arquitetura ou estado de migração.

### 17.6. Honduras, México e Chile — moeda e regras locais

**Cenário.** A fala usa lempira de Honduras, pesos chilenos, UDI do México e UF do Chile como exemplos de parametrização monetária/local.

**Situação/lição.** São exemplos didáticos de capacidade multi-moeda e de unidades financeiras, não confirmação de configuração produtiva específica.

## 18. Roadmap e evolução

Evoluções explicitamente citadas:

- NewTron, lançado em 2017 na tabela, é descrito como presente e futuro da aplicação;
- novas funcionalidades deixam de ser entregues para versões anteriores e são direcionadas a NewTron em diante;
- países em versões antigas precisam planejar migração/evolução;
- sessões futuras abordariam plano de tramitação em sinistros e conceitos de emissão de maneira detalhada, com duas sessões previstas para dezembro segundo a fala;
- a documentação REEF está “viva”, em processo de incremento, e ainda não contém tudo.

Não há datas de migração por país, calendário de release, backlog priorizado, prazo para encerramento de versões legadas ou plano de transição técnica.

## 19. Números e indicadores citados

| Indicador / Métrica | Valor declarado | Contexto e interpretação |
|---|---:|---|
| Início de Tronador | 1989 | Linha do tempo documental. |
| Tron2000 | 1993 | Linha do tempo documental. |
| TronWeb/WebTronWeb | 2002 | Linha do tempo documental. |
| TRON21 | 2007 | Linha do tempo documental. |
| NewTron | 2017 | Linha do tempo documental. |
| Tempo de base/evolução | “30 anos” | Declaração verbal aproximada de consolidação temporal. |
| Países usuários | 23 | Declaração verbal; não reconciliada com a tabela. |
| Companhias em Puerto Rico | 3 | Exemplo verbal de uso multi-companhia. |
| Idiomas de caixa | 2 | Espanhol e inglês declarados. |
| Níveis da estrutura geográfica | 5 | País, subdivisões geográficas até distrito, conforme exemplo espanhol. |
| Níveis estrutura comercial | 3 | Declaração verbal. |
| Níveis estrutura de produtos | 3 | Declaração verbal. |
| Níveis estrutura de canais | 3 | Declaração verbal. |
| Limite etário ilustrativo | 18 anos | Exemplo didático de regra de saúde, não política confirmada. |
| Sessões futuras mencionadas | 2 | Sessões de dezembro referidas verbalmente. |

Os valores são declarações feitas na reunião ou observados nos slides; não representam indicadores auditados.

## 20. Mapa cronológico integrado da sessão (Fala + Telas)

| Timestamp | Frame / Tela Exibida | Evidência Visual Chave & OCR | Tópico Técnico Discutido na Fala |
|---|---|---|---|
| 03:42 | Frame 01 | Portal Documentación REEF; árvore `01 TRON` e `02 ARQUITECTURA`. | Abertura do portal e introdução à documentação REEF/TRON. |
| 07:19 | Frame 02 | Videoconferência. | Ignorado como ruído visual. |
| 10:56 | Frame 03 | Desktop com atalhos. | Ignorado como ruído visual; não documenta sistemas por ícones. |
| 14:34 | Frame 04 | Tabela Evolución Versiones: Tronador, Tron2000, TronWeb/WebTronWeb, TRON21, NewTron. | História, reengenharias e evolução de versões. |
| 18:11 | Frame 05 | Presencia Internacional, incluindo nota sobre Filipinas. | Expansão geográfica e países que usaram/usam a solução. |
| 21:48 | Frame 06 | Características corporativas e início das operativas. | Plataforma por/para MAPFRE, escalabilidade e objetivo de seguros. |
| 25:25 | Frame 07 | Confiabilidade, ciclo de vida, multi-companhia, multi-país, multi-moeda, multi-idioma. | Características operacionais e necessidade de boa configuração. |
| 29:02 | Frame 08 | Acessos/roles; características orientadas ao produto. | Produto, gerador/configuração e múltiplas linhas de negócio. |
| 32:40 | Frame 09 | Identificação única, pessoas/atividades, omnicanalidade e coletivos. | Gestão de cliente, terceiros, canais e IQRF. |
| 36:17 | Frame 10 | Solução modular integrada; Tesorería, Contabilidad e Flexibilidad. | Módulos TRON, parâmetros, regras e integração com REEF. |
| Sem frame específico | — | — | Pergunta sobre Panamá/NewTron; módulo de Comunes; idiomas, moedas, usuários/roles e estruturas. |

## 21. Perguntas e respostas relevantes (Q&A Exaustivo)

### 21.1. Novos países entram em NewTron ou podem escolher TRON21?

**Pergunta.** Participante pergunta se novas integrações de países usam a versão atual, entendida como NewTron, ou TRON21; cita Panamá como exemplo.

**Resposta.** O facilitador responde que Panamá entra em NewTron. Países que permanecem em versões anteriores precisam planejar migração/evolução para NewTron.

**O que essa resposta esclarece.** A orientação apresentada é centralizar novas entradas na versão atual, reduzindo expansão de versões legadas. Não detalha exceções, cronograma ou critérios de migração.

### 21.2. É correto dizer que TRON cobre todo o ciclo da apólice?

**Pergunta.** A questão é tratada na exposição: até onde vai o ciclo funcional coberto pela plataforma?

**Resposta.** A documentação e a fala dizem que a solução abrange contratação, cotação, emissão, gestão/contabilização de prêmios e sinistros, entre outros processos associados.

**O que essa resposta esclarece.** TRON é apresentado como núcleo de gestão de seguros de ponta a ponta, não como solução universal para CRM, BPM ou gestão documental.

### 21.3. TRON pode substituir CRM, BPM ou gestor documental?

**Pergunta.** A dúvida de fundo é se o sistema deve executar qualquer função empresarial necessária.

**Resposta.** O facilitador afirma que não: há soluções nascidas para CRM, BPM e gestão documental que desempenham essas funções melhor. TRON pode integrar-se a outras plataformas.

**O que essa resposta esclarece.** Integração complementa o núcleo; especialização funcional é um limite deliberado da solução.

### 21.4. A solução é multi-companhia para todos os países?

**Pergunta.** A exposição problematiza se suportar várias entidades significa que todos os países usam essa configuração.

**Resposta.** A plataforma permite mais de uma entidade seguradora na mesma instalação, mas isso não implica uso universal. Puerto Rico é citado com três companhias.

**O que essa resposta esclarece.** Multi-companhia é capacidade configurável, não característica obrigatória de cada implantação.

### 21.5. Como a solução trata moedas e câmbio?

**Pergunta.** A explicação aborda como operar em moeda local, múltiplas divisas e diferentes usos de moedas em processos.

**Resposta.** Moedas e tipos de câmbio são configurados; podem influenciar prêmios, liquidações, cobrança e tesouraria. Possibilidade de cobrar em moeda distinta da emissão é citada como operação a ser parametrizada.

**O que essa resposta esclarece.** A capacidade multi-moeda depende de configuração e decisão de negócio. A origem automática dos câmbios não foi confirmada.

### 21.6. Todos os usuários veem e fazem o mesmo no sistema?

**Pergunta.** A sessão introduz a questão de acesso às telas e permissões operacionais.

**Resposta.** A documentação diz que informações são apresentadas conforme acessos e roles dos usuários. A fala reforça usuários nominais e papéis com limites, exemplificando diferenças entre subscritor júnior, sênior e diretor técnico.

**O que essa resposta esclarece.** Existe controle funcional baseado em usuários e roles; autenticação, modelo de autorização e auditoria não foram demonstrados.

### 21.7. Como uma regra de negócio é implementada?

**Pergunta.** A questão é tratada por exemplos de restrições e controles técnicos.

**Resposta.** Parâmetros e controles técnicos podem representar regras, como solicitar acessórios, restringir temporariamente determinada aceitação de veículo ou impedir seguro de saúde para menores de 18 anos.

**O que essa resposta esclarece.** Regras podem ser configuradas, mas os exemplos são didáticos e não revelam motor, linguagem, precedência ou telas de manutenção.

### 21.8. Por que Comunes é fundamental?

**Pergunta.** A exposição explica o papel do módulo transversal diante de módulos especializados.

**Resposta.** Comunes concentra definições de uso transversal — idiomas, moedas, usuários/roles e estruturas — para garantir consistência e coerência entre Emisión, Siniestros, Tesorería e Contabilidad.

**O que essa resposta esclarece.** Conceitos comuns devem ser definidos de forma central para evitar divergência funcional nos módulos que os consomem.

## 22. Limitações reconhecidas

1. A capacitação é explicitamente introdutória e de alto nível.
2. Não foram demonstradas telas transacionais, campos, máscaras, botões, mensagens de erro ou validações.
3. A tecnologia interna de NewTron, TronWeb, TRON21 e REEF não é explicada.
4. Integrações com REEF são citadas sem APIs, protocolos, contratos ou catálogo técnico.
5. A integração com SAP é funcionalmente mencionada, sem mecanismo técnico.
6. A hipótese de API de banco central para câmbio não é confirmação de integração existente.
7. Não há catálogo de produtos pré-configurados, regras de tarifa ou impostos.
8. Não há critérios de escalabilidade, desempenho, disponibilidade ou capacidade.
9. Não há matriz completa de versão/país nem cronograma de migração para NewTron.
10. Cosseguro, resseguro, documentos e notificações não são detalhados.
11. A transcrição contém trechos degradados, especialmente nomes técnicos e alguns trechos de contexto histórico.

## 23. Riscos e desafios

### 23.1. Riscos explicitamente mencionados

- Configuração insuficiente ou incorreta pode impedir que a solução produza os resultados esperados.
- Manter funcionalidades em muitas versões/países não é sustentável, conforme argumento do facilitador.
- Falta de consistência em conceitos transversais, como moeda, compromete coerência entre módulos.
- Aplicar uma plataforma de seguros a funções de CRM/BPM/gestão documental pode gerar expectativa inadequada.
- Regras e parâmetros mal definidos podem permitir ou bloquear captura/processamento indevido, conforme exemplos de acessórios, veículo e idade.

### 23.2. Desafios derivados do contexto

- **Análise:** conciliar parametrização local com padronização corporativa exige governança de modelos, regras e estruturas.
- **Análise:** coexistência de versões antigas e NewTron demanda inventário de dependências e estratégia de migração, não apresentada.
- **Análise:** centralizar moedas, estruturas comerciais e canais torna a qualidade da configuração basal para vários módulos.
- **Análise:** uma plataforma multi-país/multi-moeda precisa tratar diferenças regulatórias e operacionais sem que o conteúdo prove como isso ocorre tecnicamente.
- **Análise:** integração com soluções especializadas do REEF amplia escopo funcional, mas introduz dependências cuja segurança, disponibilidade e suporte não foram descritos.

## 24. Transformações estruturais identificadas

1. **Evolução histórica da aplicação.** A linha do tempo aponta sucessivas reengenharias e redesenhos: Tronador → Tron2000 → TronWeb/WebTronWeb → TRON21 → NewTron.
2. **De customização isolada a orientação corporativa.** A fala descreve avaliação de evolutivos com sentido para diversos países e direcionamento de novas capacidades à versão atual.
3. **De funcionalidades dispersas a modularidade integrada.** Emissão, Sinistros, Tesouraria, Contabilidade, Terceiros e Comunes são apresentados como módulos distintos que compartilham dados.
4. **De comportamento fixo a configuração por parâmetros.** Valores, listas, estruturas, numerações e controles técnicos influenciam interface, regras e processos.
5. **De operação de canal único a omnicanalidade.** A contratação pode ocorrer por telefone, web, agente, mediador ou banca-seguros, preservando origem/canal da apólice.

São leituras estruturais do conteúdo apresentado; não constituem roadmap formal de transformação empresarial.

## 25. O que a reunião NÃO permite concluir

- Arquitetura de nuvem, rede, containers, Kubernetes, servidores ou data centers.
- Banco de dados específico, tabelas, schemas, chaves, packages, procedures, sinônimos ou modelo físico.
- Linguagens, frameworks, padrões de front-end/back-end ou APIs internas de NewTron/TRON21/TronWeb.
- Endpoints, protocolos, autenticação, autorização, criptografia, auditoria ou gestão de segredos.
- Mecanismo técnico de compartilhamento “em tempo real”, consistência transacional ou replicação.
- Integração concreta com SAP, REEF ou Banco Central.
- Lista de produtos pré-configurados, taxas, impostos, fórmulas de prêmio ou regras atuariais.
- Disponibilidade efetiva de cada capacidade por país ou versão.
- SLAs, RTO/RPO, disaster recovery, observabilidade, monitoramento ou suporte operacional.
- Detalhes de cosseguro, resseguro, gestão documental e notificações.

## 26. Glossário terminológico, siglas e entidades

| Termo / Sigla | Significado / Expansão | Descrição e Papel no Ecossistema |
|---|---|---|
| REEF | Não expandido na fonte | Portal/ecossistema de documentação e soluções citado para integração. |
| TRON | Não expandido na fonte | Solução integral de gestão de seguros. |
| Tronador | Denominação histórica | Aplicação de 1989, adaptada de sistema argentino. |
| Tron2000 | Denominação histórica | Versão de 1993 com reengenharia/redesenho/evolução funcional. |
| TronWeb / WebTronWeb | Denominação histórica | Versão de 2002, com frontal Java/HTML segundo tabela. |
| TRON21 | Denominação histórica | Adaptação de back-end para MAPFRE Espanha em 2007. |
| NewTron | Denominação de versão | Reengenharia/redesenho/evolução de 2017; “Neutron” no Whisper é interpretado contextualmente como NewTron. |
| Comunes | Módulo de Comuns | Configuração transversal de idiomas, moedas, usuários/roles e estruturas. |
| Terceros | Módulo de Terceiros | Cadastro de pessoas físicas/jurídicas e papéis relacionados à seguradora. |
| Emisión / Suscripción | Emissão / Subscrição | Contratação, criação e gestão de apólices. |
| Siniestros | Sinistros | Gestão de sinistros e prestações. |
| Tesorería | Tesouraria | Gestão financeira de cobranças e pagamentos. |
| Contabilidad | Contabilidade | Processos de contabilização. |
| IQRF | Não expandido na fonte | Gestão/seguimento de incidências, queixas, reclamações e felicitações. |
| SAP | Não expandido na fonte | Solução corporativa de contabilização citada. |
| Multi-compañía | Multi-companhia | Configuração de mais de uma seguradora na mesma plataforma. |
| Multi-país | Multi-país | Operação/configuração para mais de um país. |
| Multi-moneda | Multi-moeda | Gestão de apólices e processos em divisas configuradas. |
| Multi-idioma | Multi-idioma | Literais/telas disponíveis em idiomas configurados; espanhol e inglês são citados como de caixa. |
| UDI | Não expandido na fonte | Unidade de valor financeiro citada para México. |
| UF | Unidad de Fomento | Unidade de fomento citada para Chile. |
| Control técnico | Controle técnico | Regra de negócio dinâmica associável a roles de usuários no processo de emissão. |
| Ramo contable | Ramo contábil | Código contábil que relaciona estrutura técnica e contábil ao nível de cobertura/garantia, segundo explicação. |

## 27. Conclusões principais

A sessão posiciona TRON como solução corporativa e integral de seguros, com longa evolução histórica, alcance internacional e capacidades de ciclo de vida de apólice. A evidência visual confirma as denominações históricas, a presença internacional e a organização de capacidades corporativas, operativas, orientadas ao produto e ao cliente.

A arquitetura demonstrada é funcionalmente modular: Comunes concentra definições transversais; Terceros mantém participantes; Emisión, Siniestros, Tesorería e Contabilidad executam domínios especializados e compartilham informações operacionais. A flexibilidade reside na parametrização de valores, listas, estruturas, numerações e controles técnicos.

O direcionamento estratégico declarado é NewTron como destino para novos países e novas funcionalidades, com necessidade de evolução/migração para instalações anteriores. Integrações com REEF e, em alguns contextos, SAP complementam o núcleo, mas seus detalhes técnicos permanecem ausentes.

A reunião não sustenta conclusões sobre arquitetura física, APIs, banco de dados, segurança, infraestrutura, algoritmos de tarifa, plano de migração ou suporte operacional. Essas lacunas foram preservadas explicitamente para evitar transformar hipóteses em fatos.
