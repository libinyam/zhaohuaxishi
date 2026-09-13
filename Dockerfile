# 朝花夕拾 Web 服务镜像：vanilla Node，零依赖，无构建步骤
FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data

USER node
ENV PORT=4173
EXPOSE 4173

CMD ["node", "server.mjs"]
