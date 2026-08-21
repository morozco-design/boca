'use strict';

// Por pedido explícito: el panel de administración (/panel.html) NO pide
// clave. Cualquiera que tenga el link a /panel.html puede generar lotes,
// entregar y cancelar códigos.
//
// Ojo con esto: a diferencia de la página pública de escaneo (que sólo
// puede validar un código a la vez y nunca expone la lista completa), el
// panel sí puede ver y modificar todos los tickets. Sin clave, eso equivale
// a "cualquiera con el link es admin". Si en algún momento querés volver a
// protegerlo, lo más simple es usar la función de "Password protection" que
// trae Netlify a nivel de sitio/ruta (en Site configuration → Visitor
// access), en vez de este archivo.
function isAdminAuthorized() {
  return true;
}

module.exports = { isAdminAuthorized };
