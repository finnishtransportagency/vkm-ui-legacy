$(function() {
  var fileName = window.location.hash.substring(1);
  if (fileName) { pollResponse(fileName); }

  var loader = $("#loading");
  var ready = $("#ready");
  var error = $("#error");
  function handleReady(res) {
    $("#download").attr("href", downloadUrl(res));
    loader.addClass("hidden");
    ready.removeClass("hidden");
    error.addClass("hidden");
  }

  function handlePending(res) {
    loader.removeClass('hidden');
    ready.addClass("hidden");
    error.addClass("hidden");
    setTimeout(function() { pollResponse(res); }, 1000);
  }

  function handleError() {
    loader.addClass("hidden");
    ready.addClass("hidden");
    error.removeClass("hidden");
  }

  function pollResponse(res) {
    $.ajax("/status/" + res, {
      statusCode: {
        200: handleReady,
        202: handlePending,
        500: handleError
      }
    });
  }

  $('#upload').on('submit', function(event) {
    event.preventDefault();

    loader.removeClass('hidden');

    $.ajax({
      url: '/upload',
      type: 'POST',
      data: new FormData($(this)[0]),
      cache: false,
      processData: false,
      contentType: false
    }).done(function(res) {
      window.location.hash = res;
      pollResponse(res);
    }).fail(handleError);
  });

  function downloadUrl(fileName) {
    return "download/" + fileName;
  }
});
